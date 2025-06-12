import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class BorrowAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("BorrowAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const safeOwners = currentSnapshot.contractSnapshot.stableBaseCDP.safeOwners;

        let safeId: number | undefined = undefined;
        for (const id in safeOwners) {
            if (safeOwners[id] === actor.account.address) {
                safeId = parseInt(id);
                break;
            }
        }

        if (safeId === undefined) {
            console.log("No safe owned by actor");
            return [false, {}, {}];
        }

        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP
        const safe = stableBaseCDPSnapshot.safesData[safeId];
        if (!safe) {
            console.log(`Safe with id ${safeId} not found`);
            return [false, {}, {}];
        }

        const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle
        const price = mockPriceOracleSnapshot.currentPrice;
        const liquidationRatio = 15000; // Example liquidation ratio, adjust as needed
        const BASIS_POINTS_DIVISOR = 10000;
        const PRECISION = BigInt(10) ** BigInt(18);
        const MINIMUM_DEBT = BigInt(2000) * BigInt(10) ** BigInt(18);

        const maxBorrowAmount = ((
            (safe.collateralAmount * price * BigInt(BASIS_POINTS_DIVISOR))
        ) / BigInt(liquidationRatio)) / PRECISION;

        const currentBorrowedAmount = safe.borrowedAmount;

        let amount: bigint = BigInt(context.prng.next()) % (maxBorrowAmount - currentBorrowedAmount);
        if (amount <= BigInt(0)) {
            amount = maxBorrowAmount / BigInt(2);
        }

        if (amount + safe.borrowedAmount < MINIMUM_DEBT) {
            amount = MINIMUM_DEBT - safe.borrowedAmount;
        }

        const shieldingRate = BigInt(context.prng.next()) % BigInt(BASIS_POINTS_DIVISOR);
        const nearestSpotInLiquidationQueue = BigInt(0); // For simplicity
        const nearestSpotInRedemptionQueue = BigInt(0); // For simplicity

        const actionParams = {
            safeId: BigInt(safeId),
            amount: amount,
            shieldingRate: shieldingRate,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
            nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        return this.contract.connect(actor.account.value).borrow(
            actionParams.safeId,
            actionParams.amount,
            actionParams.shieldingRate,
            actionParams.nearestSpotInLiquidationQueue,
            actionParams.nearestSpotInRedemptionQueue,
            {
                gasLimit: 1000000
            }
        );
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const safeId = actionParams.safeId;
        const amount = actionParams.amount;
        const shieldingRate = actionParams.shieldingRate;

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP

        const previousSafe = previousStableBaseCDPSnapshot.safesData[Number(safeId)];
        const newSafe = newStableBaseCDPSnapshot.safesData[Number(safeId)];


        expect(newSafe, `Safe ${safeId} should exist after borrowing`).to.not.be.undefined

        const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
        const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

        const previousProtocolMode = previousStableBaseCDPSnapshot.protocolMode;
        const newProtocolMode = newStableBaseCDPSnapshot.protocolMode;

        const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target
        const previousContractBalance = previousSnapshot.contractSnapshot.dfidToken.balances[dfidTokenAddress] || BigInt(0);
        const newContractBalance = newSnapshot.contractSnapshot.dfidToken.balances[dfidTokenAddress] || BigInt(0);

        const BASIS_POINTS_DIVISOR = 10000;
        const BOOTSTRAP_MODE_DEBT_THRESHOLD = BigInt(5000000) * BigInt(10) ** BigInt(18);

        const shieldingFee = (amount * shieldingRate) / BigInt(BASIS_POINTS_DIVISOR);
        const amountToBorrow = amount - shieldingFee;

        // Safe State validations
        expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amount, "Borrowed amount should increase by the borrow amount.");
        expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amount, "Total borrowed amount should increase by the borrow amount.");
        expect(newSafe.feePaid).to.gte(previousSafe.feePaid + shieldingFee, "Fee paid should increase by the shielding fee amount.");

        // Total Debt validation
        expect(newTotalDebt).to.equal(previousTotalDebt + amount, "Total debt should increase by the borrowed amount.");

        // Protocol Mode Validation
        if (previousTotalDebt <= BOOTSTRAP_MODE_DEBT_THRESHOLD) {
            if (newTotalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD) {
                expect(newProtocolMode).to.equal(1, "Protocol mode should be NORMAL"); // Assuming NORMAL is represented by 1
            } else {
                expect(newProtocolMode).to.equal(previousProtocolMode, "Protocol mode should remain unchanged");
            }
        }

        // DFIDToken Balance validation for borrower
        expect(newAccountBalance).to.equal(previousAccountBalance + amountToBorrow, "Borrower's SBD token balance should increase by the borrowed amount minus the shielding fee");

        // Validation for contract's SBD token balance
        const feeDistributedEvent = executionReceipt.events?.find((event: any) => event.event === 'FeeDistributed');
        let sbrStakersFee = BigInt(0);
        let stabilityPoolFee = BigInt(0);
        let canRefund = BigInt(0);

        if (feeDistributedEvent) {
            sbrStakersFee = BigInt(feeDistributedEvent.args.sbrStakersFee);
            stabilityPoolFee = BigInt(feeDistributedEvent.args.stabilityPoolFee);
            canRefund = BigInt(feeDistributedEvent.args.canRefund);
        }

        let expectedContractBalanceChange = shieldingFee - canRefund; //Shielding fee increases, refund decreases

        expect(newContractBalance).to.equal(previousContractBalance + expectedContractBalanceChange, 'Contract SBD balance should change by shielding fee - refund');

        //Doubly Linked List Validations : Need to mock doubly linked list to perform these validations since we don't have access to it right now
        //Skipping Doubly Linked List Validations

        //Liquidation Snapshots Update Validations : Also skipping since cumulativeDebtPerUnitCollateral, cumulativeCollateralPerUnitCollateral doesn't change in code.
        //Skipping Liquidation Snapshots Update Validations

        return true;
    }
}
