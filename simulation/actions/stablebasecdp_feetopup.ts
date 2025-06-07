import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { expect } from 'chai';

export class FeeTopupAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("FeeTopupAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safeIds = Object.keys(stableBaseCDP.safes).map(Number);

        if (safeIds.length === 0) {
            throw new Error("No safes available for fee topup");
        }

        // Filter safeIds to find only the safe owned by actor.account.address
        const actorSafeIds = safeIds.filter(safeId => stableBaseCDP.ownerOf[safeId] === actor.account.address);

        if (actorSafeIds.length === 0) {
            throw new Error("No safes owned by the actor for fee topup");
        }

        const safeId = actorSafeIds[Math.floor(context.prng.next() % actorSafeIds.length)];
        const safe = stableBaseCDP.safes[BigInt(safeId)];

        // Ensure topupRate is within reasonable bounds, using a percentage of the borrowedAmount
        const maxTopupRate = (safe.borrowedAmount * BigInt(10)) / BigInt(100); // Up to 10% of borrowedAmount
        const topupRate = BigInt(Math.floor(Number(context.prng.next() % BigInt(1000)) + 1)); //topupRate between 1 and 1000

        const safesOrderedForRedemption = currentSnapshot.contractSnapshot.safesOrderedForRedemption;
        const nearestSpotInRedemptionQueue = BigInt(safesOrderedForRedemption.head || 0);

        const actionParams = [
            BigInt(safeId),
            topupRate,
            nearestSpotInRedemptionQueue
        ];

        return [actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const signer = actor.account.value.connect(this.contract.provider);
        const tx = await this.contract.connect(signer).feeTopup(
            actionParams[0],
            actionParams[1],
            actionParams[2]
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
        const topupRate = actionParams[1];
        const oldSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];
        const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];
        const fee = (topupRate * oldSafe.borrowedAmount) / BigInt(10000);

        const previousStableBaseCDPBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balanceOf[(this.contract as any).target] || BigInt(0);
        const newStableBaseCDPBalance = newSnapshot.contractSnapshot.stableBaseCDP.balanceOf[(this.contract as any).target] || BigInt(0);

        const previousUserBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newUserBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        // Safe State Validations
        expect(newSafe.weight).to.equal(oldSafe.weight + topupRate, "Safe weight should be updated by topupRate.");
        expect(newSafe.feePaid).to.equal(oldSafe.feePaid + fee, "Safe feePaid should be increased by fee.");

        // Token Balances Validations
        expect(newStableBaseCDPBalance).to.equal(previousStableBaseCDPBalance + fee, "The contract should receive 'fee' amount of SBD tokens.");
        expect(newUserBalance).to.equal(previousUserBalance - fee, "The msg.sender's SBD token balance should decrease by 'fee'.");

        return true;
    }
}