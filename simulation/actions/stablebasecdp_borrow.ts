import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia;
import { ethers } from 'ethers';
import { expect } from 'chai';

export class BorrowAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("BorrowAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        // Generate random values for parameters
        const safeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes);
        const safeId = safeIds.length > 0 ? BigInt(safeIds[Math.floor(context.prng.next() % safeIds.length)]) : BigInt(0);
        const amount = BigInt(Math.floor(context.prng.next() % 1000) + 1); // Non-zero amount
        const shieldingRate = BigInt(Math.floor(context.prng.next() % 10001)); // Between 0 and 10000
        const nearestSpotInLiquidationQueue = BigInt(Math.floor(context.prng.next() % 2)); // 0 or 1 for simplicity
        const nearestSpotInRedemptionQueue = BigInt(Math.floor(context.prng.next() % 2)); // 0 or 1 for simplicity

        const actionParams = [
            safeId,
            amount,
            shieldingRate,
            nearestSpotInLiquidationQueue,
            nearestSpotInRedemptionQueue,
        ];

        return [actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const signer = actor.account.value as ethers.Signer;
        const tx = await this.contract.connect(signer).borrow(
            actionParams[0],
            actionParams[1],
            actionParams[2],
            actionParams[3],
            actionParams[4]
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
        const safeId = actionParams[0];
        const amount = BigInt(actionParams[1]);
        const shieldingRate = actionParams[2];

        // Use default values to prevent undefined property access
        const prevSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId] || { collateralAmount: BigInt(0), borrowedAmount: BigInt(0), weight: BigInt(0), totalBorrowedAmount: BigInt(0), feePaid: BigInt(0) };
        const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId] || { collateralAmount: BigInt(0), borrowedAmount: BigInt(0), weight: BigInt(0), totalBorrowedAmount: BigInt(0), feePaid: BigInt(0) };

        const prevTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
        const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;

        const actorAddress = actor.account.address;
        const prevActorBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
        const newActorBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);

        const contractAddress = this.contract.target;
        const prevContractBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balances[contractAddress] || BigInt(0);
        const newContractBalance = newSnapshot.contractSnapshot.stableBaseCDP.balances[contractAddress] || BigInt(0);

        // Borrowing & Debt
        // Check if safe existed in previous snapshot before making assertions
        if (previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId]) {
            expect(newSafe.borrowedAmount).to.equal(prevSafe.borrowedAmount + amount, "Borrowed amount should increase by amount");
            expect(newSafe.totalBorrowedAmount).to.equal(prevSafe.totalBorrowedAmount + amount, "Total borrowed amount should increase by amount");
        }
        else {
            expect(newSafe.borrowedAmount).to.equal(amount, "Borrowed amount should equal amount for new safe");
            expect(newSafe.totalBorrowedAmount).to.equal(amount, "Total borrowed amount should equal amount for new safe");
        }
        expect(newTotalDebt).to.equal(prevTotalDebt + amount, "Total debt should increase by amount");
        expect(newActorBalance).to.be.gt(prevActorBalance, "Actor balance should increase");

        // Fee & Weight - basic check, more detailed checks would require more context on shielding fee calculation
        expect(newSafe.feePaid).to.be.gte(prevSafe.feePaid, "Fee paid should increase or remain the same");
        expect(newSafe.weight).to.be.gte(BigInt(0), "Weight should be non-negative");

        // Contract Balance should decrease
        expect(newContractBalance).to.be.lte(prevContractBalance, "Contract balance should decrease or remain the same");

        // Check for system state changes based on debt threshold would require access to constants


        return true;
    }
}
