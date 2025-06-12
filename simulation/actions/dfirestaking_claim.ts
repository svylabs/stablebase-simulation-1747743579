import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class ClaimAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("ClaimAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const dfireStakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
        const stakes = dfireStakingSnapshot.stakes;
        const userAddress = actor.account.address;

        if (!stakes[userAddress] || stakes[userAddress].stake === BigInt(0)) {
            console.log("User has no staked tokens.");
            return [false, [], {}];
        }

        const userPendingReward = dfireStakingSnapshot.userPendingReward[userAddress];

        if (!userPendingReward || (userPendingReward[0] === BigInt(0) && userPendingReward[1] === BigInt(0))) {
            console.log("No claimable rewards exist.");
            return [false, [], {}];
        }


        return [true, [], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const tx = await this.contract.connect(actor.account.value).claim();
        const receipt = await tx.wait();
        return { receipt };
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
        const previousDfireStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

        const previousStakes = previousDfireStakingSnapshot.stakes;
        const newStakes = newDfireStakingSnapshot.stakes;

        const previousTotalRewardPerToken = previousDfireStakingSnapshot.totalRewardPerToken;
        const newTotalRewardPerToken = newDfireStakingSnapshot.totalRewardPerToken;

        const previousTotalCollateralPerToken = previousDfireStakingSnapshot.totalCollateralPerToken;
        const newTotalCollateralPerToken = newDfireStakingSnapshot.totalCollateralPerToken;

        const rewardTokenAddress = previousDfireStakingSnapshot.rewardToken;
        const previousRewardTokenBalanceContract = (previousSnapshot.contractSnapshot as any)[rewardTokenAddress].accountBalance[this.contract.target];
        const newRewardTokenBalanceContract = (newSnapshot.contractSnapshot as any)[rewardTokenAddress].accountBalance[this.contract.target];

        const previousRewardTokenBalanceUser = (previousSnapshot.contractSnapshot as any)[rewardTokenAddress].accountBalance[userAddress];
        const newRewardTokenBalanceUser = (newSnapshot.contractSnapshot as any)[rewardTokenAddress].accountBalance[userAddress];

        const previousEthBalanceUser = previousSnapshot.accountSnapshot[userAddress];
        const newEthBalanceUser = newSnapshot.accountSnapshot[userAddress];

        const userStakeBefore = previousStakes[userAddress];
        const userStakeAfter = newStakes[userAddress];


        // Reward Claim
        expect(userStakeAfter.rewardSnapshot).to.equal(newTotalRewardPerToken, "User reward snapshot matches total reward per token");
        expect(userStakeAfter.collateralSnapshot).to.equal(newTotalCollateralPerToken, "User collateral snapshot matches total collateral per token");

        const reward = ((newTotalRewardPerToken - previousTotalRewardPerToken) * userStakeBefore.stake) / previousDfireStakingSnapshot.PRECISION;
        const collateralReward = ((newTotalCollateralPerToken - previousTotalCollateralPerToken) * userStakeBefore.stake) / previousDfireStakingSnapshot.PRECISION;

        if (reward > BigInt(0)) {
            expect(newRewardTokenBalanceUser - previousRewardTokenBalanceUser).to.equal(reward, "User's reward token balance increased by reward amount");
            expect(previousRewardTokenBalanceContract - newRewardTokenBalanceContract).to.equal(reward, "RewardToken contract balance decreased by reward amount");
        }
        else {
             expect(newRewardTokenBalanceUser).to.equal(previousRewardTokenBalanceUser, "User's reward token balance did not change");
        }

        if (collateralReward > BigInt(0)) {
            expect(newEthBalanceUser - previousEthBalanceUser).to.equal(collateralReward, "User's ether balance increased by collateral reward amount");
        }
        else {
            expect(newEthBalanceUser).to.equal(previousEthBalanceUser, "User's ether balance did not change");
        }
        

        // Staking Status
        expect(userStakeAfter.stake).to.equal(userStakeBefore.stake, "User's staked amount remains unchanged");

        return true;
    }
}
