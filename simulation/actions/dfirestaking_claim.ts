import { Action, Actor, Snapshot, ExecutionReceipt } from "@svylabs/ilumina";
import type RunContext from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

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
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
        const stakeInfo = dfireStakingSnapshot.stakeByUser[actor.account.address];

        if (!stakeInfo || stakeInfo.stake === BigInt(0)) {
            return [false, {}, {}];
        }

        const totalRewardPerToken = dfireStakingSnapshot.totalRewardPerToken;
        const totalCollateralPerToken = dfireStakingSnapshot.totalCollateralPerToken;
        const rewardDecimals = dfidTokenSnapshot.decimals;
        const rewardPrecision = BigInt(10 ** rewardDecimals);

        const rewardOwed = ((totalRewardPerToken - stakeInfo.rewardSnapshot) * stakeInfo.stake) / rewardPrecision;
        const collateralRewardOwed = ((totalCollateralPerToken - stakeInfo.collateralSnapshot) * stakeInfo.stake) / rewardPrecision;

        if (rewardOwed <= BigInt(0) && collateralRewardOwed <= BigInt(0)) {
            return [false, {}, {}];
        }

        return [true, {}, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const tx = await this.contract.connect(actor.account.value).claim();
        const receipt = await tx.wait();
        return receipt;
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const previousDfireStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;
        const previousDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const previousRewardTokenBalance = previousDfidTokenSnapshot.balances[actor.account.address] || BigInt(0);
        const newRewardTokenBalance = newDfidTokenSnapshot.balances[actor.account.address] || BigInt(0);

        const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newEthBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        const stakeInfoBefore = previousDfireStakingSnapshot.stakeByUser[actor.account.address];
        const stakeInfoAfter = newDfireStakingSnapshot.stakeByUser[actor.account.address];

        const totalRewardPerTokenBefore = previousDfireStakingSnapshot.totalRewardPerToken;
        const totalRewardPerTokenAfter = newDfireStakingSnapshot.totalRewardPerToken;
        const totalCollateralPerTokenBefore = previousDfireStakingSnapshot.totalCollateralPerToken;
        const totalCollateralPerTokenAfter = newDfireStakingSnapshot.totalCollateralPerToken;

        const rewardDecimals = previousDfidTokenSnapshot.decimals;
        const rewardPrecision = BigInt(10 ** rewardDecimals);

        const rewardOwed = ((totalRewardPerTokenBefore - stakeInfoBefore.rewardSnapshot) * stakeInfoBefore.stake) / rewardPrecision;
        const collateralRewardOwed = ((totalCollateralPerTokenBefore - stakeInfoBefore.collateralSnapshot) * stakeInfoBefore.stake) / rewardPrecision;

        // Validate reward token balance increase
        if (rewardOwed > BigInt(0)) {
            expect(newRewardTokenBalance - previousRewardTokenBalance).to.be.gte(rewardOwed, "Reward token balance should increase by at least the reward amount");
        }

        // Validate collateral (ETH) balance increase
        if (collateralRewardOwed > BigInt(0)) {
            expect(newEthBalance - previousEthBalance).to.be.gte(collateralRewardOwed, "Collateral (ETH) balance should increase by at least the collateral reward amount.");
        }

        // Validate user state update: rewardSnapshot
        expect(stakeInfoAfter.rewardSnapshot).to.eq(totalRewardPerTokenAfter, "User's rewardSnapshot should be updated to the current totalRewardPerToken");

        // Validate user state update: collateralSnapshot
        expect(stakeInfoAfter.collateralSnapshot).to.eq(totalCollateralPerTokenAfter, "User's collateralSnapshot should be updated to the current totalCollateralPerToken");

        // Validate Claimed event
        const claimedEvent = executionReceipt.logs.find(
            (log) => log.name === "Claimed"
        );

        expect(claimedEvent).to.not.be.undefined;
        expect(claimedEvent.args.account).to.eq(actor.account.address);
        expect(claimedEvent.args.reward).to.gte(rewardOwed);
        expect(claimedEvent.args.collateralReward).to.gte(collateralRewardOwed);

        return true;
    }
}
