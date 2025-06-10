import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class AddCollateralAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("AddCollateralAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const safeId = BigInt(actor.identifiers.safeId || 0);

        if (!currentSnapshot.contractSnapshot.stableBaseCDP.safes[Number(safeId)]) {
            console.log("Safe does not exist.");
            return [false, {}, {}];
        }

        const previousSafe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[Number(safeId)];
        const maxCollateralAmount = currentSnapshot.accountSnapshot[actor.account.address] || 0n;
        if (maxCollateralAmount <= 0n) {
            console.log("Not enough ETH balance to add collateral.");
            return [false, {}, {}];
        }

        // Limit the amount to avoid potential overflows. A more sophisticated approach might be needed.
        const amount = BigInt(Math.floor(context.prng.next() % Number(maxCollateralAmount / 2n)) + 1); // Ensure amount is > 0 and less than half of the available balance
        const nearestSpotInLiquidationQueue = BigInt(Math.floor(context.prng.next() % 10)); // Random value for now

        const actionParams = {
            safeId: safeId,
            amount: amount,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
            value: amount // msg.value
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { safeId, amount, nearestSpotInLiquidationQueue, value } = actionParams;
        const tx = await this.contract.connect(actor.account.value).addCollateral(
            safeId,
            amount,
            nearestSpotInLiquidationQueue,
            { value: value }
        );
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const { safeId, amount } = actionParams;

        const previousSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[Number(safeId)] || {
            collateralAmount: 0n,
            borrowedAmount: 0n,
            totalBorrowedAmount: 0n,
            feePaid: 0n,
            weight: 0n
        };
        const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[Number(safeId)] || {
            collateralAmount: 0n,
            borrowedAmount: 0n,
            totalBorrowedAmount: 0n,
            feePaid: 0n,
            weight: 0n
        };

        const previousTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
        const newTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;

         const previousTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
        const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;


        // Collateral Management Validation
        expect(newSafe.collateralAmount).to.be.gte(previousSafe.collateralAmount + amount, "Collateral amount should increase by amount or more due to cumulative updates");
        expect(newTotalCollateral).to.be.gte(previousTotalCollateral + amount, "Total collateral should increase by amount or more due to cumulative updates");

        //Borrowed amount can increase due to cumulative updates
        expect(newSafe.borrowedAmount).to.be.gte(previousSafe.borrowedAmount, "Borrowed amount can increase due to cumulative updates");


        // Input Validation
        expect(executionReceipt.gasUsed).to.be.greaterThan(0, "Gas should be used");

        // ETH Balance Validation
        const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address] || 0n;
        const newEthBalance = newSnapshot.accountSnapshot[actor.account.address] || 0n;
        const gasCost = executionReceipt.gasUsed * executionReceipt.effectiveGasPrice;
        expect(newEthBalance).to.equal(previousEthBalance - amount - gasCost, "ETH balance should decrease by amount and gas cost");

        //Liquidation Snapshot validation. DebtPerCollateralSnapshot should match cumulativeDebtPerUnitCollateral.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.debtPerCollateralSnapshot[Number(safeId)]).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral, 'debtPerCollateralSnapshot must match cumulativeDebtPerUnitCollateral');
        expect(newSnapshot.contractSnapshot.stableBaseCDP.collateralPerCollateralSnapshot[Number(safeId)]).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral, 'collateralPerCollateralSnapshot must match cumulativeCollateralPerUnitCollateral');


        //Protocol mode validation
         if (previousSnapshot.contractSnapshot.stableBaseCDP.PROTOCOL_MODE === 'BOOTSTRAP') {
            const bootstrapModeDebtThreshold = 1000;  // Assuming this value, replace with actual snapshot if available

            if (newSnapshot.contractSnapshot.stableBaseCDP.totalDebt > bootstrapModeDebtThreshold) {
                expect(newSnapshot.contractSnapshot.stableBaseCDP.PROTOCOL_MODE).to.equal('NORMAL', 'protocol mode should be NORMAL');
            }
        }

        return true;
    }
}
