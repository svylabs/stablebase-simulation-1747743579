import { ethers } from "ethers";
import { expect } from 'chai';
import { Action, Actor, RunContext, Snapshot } from "@svylabs/ilumia";

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
    ): Promise<[any, Record<string, any>]> {
        const safeId = BigInt(actor.identifiers['safeId']);
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safe = stableBaseCDPSnapshot.safes[safeId];
        const price = BigInt(1000000000); // Assuming price is fixed for now
        const liquidationRatio = BigInt(15000);
        const PRECISION = BigInt(1000000000);
        const BASIS_POINTS_DIVISOR = BigInt(10000);
        const MINIMUM_DEBT = BigInt(1000000000000000000); // 1 SBD

        const maxBorrowAmount = ((safe.collateralAmount * price * BASIS_POINTS_DIVISOR) / liquidationRatio) / PRECISION;
        const borrowedAmount = safe.borrowedAmount;

        let amount = BigInt(context.prng.next()) % (maxBorrowAmount - borrowedAmount);
        if (amount < MINIMUM_DEBT) {
            amount = MINIMUM_DEBT;
        }
        const shieldingRate = BigInt(context.prng.next()) % BASIS_POINTS_DIVISOR; // Up to 100%
        const nearestSpotInLiquidationQueue = BigInt(0);
        const nearestSpotInRedemptionQueue = BigInt(0);

        const params = [
            safeId,
            amount,
            shieldingRate,
            nearestSpotInLiquidationQueue,
            nearestSpotInRedemptionQueue
        ];

        return [params, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const [safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue] = actionParams;

        const tx = await this.contract.connect(actor.account.value).borrow(
            safeId,
            amount,
            shieldingRate,
            nearestSpotInLiquidationQueue,
            nearestSpotInRedemptionQueue
        );

        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const [safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue] = actionParams;
        const safeIdBigInt = BigInt(safeId);
        const amountBigInt = BigInt(amount);
        const shieldingRateBigInt = BigInt(shieldingRate);

        const previousSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeIdBigInt];
        const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeIdBigInt];

        // Core Borrowing and Accounting
        expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amountBigInt, "Borrowed amount should increase by amount");
        expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amountBigInt, "Total borrowed amount should increase by amount");

        const _shieldingFee = (amountBigInt * shieldingRateBigInt) / BigInt(10000);
        expect(newSafe.feePaid).to.equal(previousSafe.feePaid + _shieldingFee, "Fee paid should increase by shielding fee");

        const previousTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
        const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;

        expect(newTotalDebt).to.equal(previousTotalDebt + amountBigInt, "Total debt should increase by amount");

        const dfidTokenAddress = (context.contracts['dfidToken'] as ethers.Contract).target;
        const previousTokenBalance = previousSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);
        const newTokenBalance = newSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);

        // Calculate the amount to borrow after shielding fee
        const _amountToBorrow = amountBigInt - _shieldingFee;

         // Verify that the contract's SBD balance increased by the amount borrowed.
        expect(newTokenBalance).to.equal(previousTokenBalance + _amountToBorrow, "Contract SBD balance should increase by amountToBorrow");

        // Fee Distribution validation will require event parsing to get accurate fee amounts.

        return true;
    }
}
