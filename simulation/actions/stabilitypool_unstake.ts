import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class UnstakeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("UnstakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
        const userAddress = actor.account.address;

        if (!stabilityPoolSnapshot.users[userAddress]) {
            console.log("User has no stake to unstake");
            return [false, {}, {}];
        }

        const userStake = stabilityPoolSnapshot.users[userAddress].stake;

        if (userStake <= BigInt(0)) {
            console.log("User has no stake to unstake");
            return [false, {}, {}];
        }

        // Consider unstaking all staked tokens as an edge case
        const unstakeAll = context.prng.next() % 2 === 0;
        const amountToUnstake = unstakeAll ? userStake : BigInt(Math.floor(context.prng.next() % Number(userStake)) + 1);

        // Consider frontend address and fee (set to 0 for direct unstake).  For simplicity, always direct unstake.
        const frontendAddress = ethers.ZeroAddress; // Direct unstake
        const fee = BigInt(0);

        const actionParams = {
            amount: amountToUnstake,
            frontend: frontendAddress,
            fee: fee,
        };

        console.log(`Unstaking ${amountToUnstake} tokens for ${userAddress}`)
        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const tx = await this.contract.connect(actor.account.value).unstake(actionParams.amount, actionParams.frontend, actionParams.fee);
        const receipt = await tx.wait();
        return {receipt};
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const userAddress = actor.account.address;
        const amountUnstaked = actionParams.amount;

        const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
        const previousDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        // 1. Stake Management Validation
        const initialUserStake = previousStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);
        const newUserStake = newStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);
        const initialTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
        const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;

        const expectedNewUserStake = initialUserStake - amountUnstaked;
        const expectedNewTotalStakedRaw = initialTotalStakedRaw - amountUnstaked;

        expect(newUserStake, "User's stake should be decreased by the unstaked amount").to.equal(expectedNewUserStake);
        expect(newTotalStakedRaw, "Total staked amount should be decreased by the unstaked amount").to.equal(expectedNewTotalStakedRaw);

        // 2. Token Balance Validation (DFIDToken)
        const initialUserBalance = previousDfidTokenSnapshot.balances[userAddress] || BigInt(0);
        const newUserBalance = newDfidTokenSnapshot.balances[userAddress] || BigInt(0);
        const expectedNewUserBalance = initialUserBalance + amountUnstaked;
        expect(newUserBalance, "User's DFID token balance should increase by the unstaked amount").to.equal(expectedNewUserBalance);

        // 3. Reward Distribution Status Validation
        const previousRewardSenderActive = previousStabilityPoolSnapshot.rewardSenderActive;
        const newRewardSenderActive = newStabilityPoolSnapshot.rewardSenderActive;
        if (initialTotalStakedRaw > BigInt(0) && newTotalStakedRaw === BigInt(0) && previousRewardSenderActive) {
            expect(newRewardSenderActive, "Reward distribution should be disabled if totalStakedRaw is zero").to.be.false;
        }

        // 4. SBR Reward Snapshot Validation (Basic check.  Expanded validation would be needed for actual reward changes)
        const previousSBRRewardSnapshot = previousStabilityPoolSnapshot.sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0);
        const newSBRRewardSnapshot = newStabilityPoolSnapshot.sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0);
        // Add more detailed checks here, e.g., against totalSbrRewardPerToken if needed

        // 5. CumulativeProductScalingFactor and StakeResetCount Validation
        const initialCumulativeProductScalingFactor = previousStabilityPoolSnapshot.users[userAddress]?.cumulativeProductScalingFactor || BigInt(0);
        const newCumulativeProductScalingFactor = newStabilityPoolSnapshot.users[userAddress]?.cumulativeProductScalingFactor || BigInt(0);
        const initialStakeResetCount = previousStabilityPoolSnapshot.users[userAddress]?.stakeResetCount || BigInt(0);
        const newStakeResetCount = newStabilityPoolSnapshot.users[userAddress]?.stakeResetCount || BigInt(0);
        const currentStakeScalingFactor = newStabilityPoolSnapshot.stakeScalingFactor;
        const currentStakeResetCount = newStabilityPoolSnapshot.stakeResetCount;

        if (initialUserStake > BigInt(0)){
            expect(newCumulativeProductScalingFactor, "Cumulative product scaling factor should be updated").to.equal(currentStakeScalingFactor);
            expect(newStakeResetCount, "Stake reset count should be updated").to.equal(currentStakeResetCount);
        }

        return true;
    }
}