import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class ClaimAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("ClaimAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        // No parameters are needed for the claim function.
        // Check if the user has any stake.
        const stake = currentSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address);

        // If the user has no stake, the action cannot be executed.
        if (stake === undefined || stake.stake === BigInt(0)) {
            return [false, [], {}];
        }

        return [true, [], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
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
        const previousStake = previousSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address);
        const newStake = newSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address);
        const totalRewardPerTokenBefore = previousSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;
        const totalRewardPerTokenAfter = newSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;
        const totalCollateralPerTokenBefore = previousSnapshot.contractSnapshot.dfireStaking.totalCollateralPerToken;
        const totalCollateralPerTokenAfter = newSnapshot.contractSnapshot.dfireStaking.totalCollateralPerToken;

        const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
        const previousRewardTokenBalance = previousSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);
        const newRewardTokenBalance = newSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);

        const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newEthBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        const PRECISION = previousSnapshot.contractSnapshot.dfireStaking.PRECISION;
        const reward = ((totalRewardPerTokenBefore - previousStake.rewardSnapshot) * previousStake.stake) / PRECISION;
        const collateralReward = ((totalCollateralPerTokenBefore - previousStake.collateralSnapshot) * previousStake.stake) / PRECISION;

        // Validate reward snapshot update
        expect(newStake.rewardSnapshot).to.equal(totalRewardPerTokenAfter, "Reward snapshot should be updated to totalRewardPerToken");

        // Validate collateral snapshot update
        expect(newStake.collateralSnapshot).to.equal(totalCollateralPerTokenAfter, "Collateral snapshot should be updated to totalCollateralPerToken");

        // Validate reward token balance increase
        if (reward > BigInt(0)) {
            expect(newRewardTokenBalance - previousRewardTokenBalance).to.equal(reward, "Reward token balance should increase by the reward amount");
        }
        else {
            expect(newRewardTokenBalance).to.equal(previousRewardTokenBalance, "Reward token balance should not change if reward is 0");
        }

        // Validate ETH balance increase
        if (collateralReward > BigInt(0)) {
            expect(newEthBalance - previousEthBalance).to.equal(collateralReward, "ETH balance should increase by the collateralReward amount");
        }
        else {
            expect(newEthBalance).to.equal(previousEthBalance, "ETH balance should not change if collateralReward is 0");
        }

        // Validate totalRewardPerToken remains the same
        expect(totalRewardPerTokenAfter).to.equal(totalRewardPerTokenBefore, "totalRewardPerToken should remain unchanged");

        // Validate totalCollateralPerToken remains the same
        expect(totalCollateralPerTokenAfter).to.equal(totalCollateralPerTokenBefore, "totalCollateralPerToken should remain unchanged");

         // Validate contract's reward token balance decrease
        const previousContractRewardTokenBalance = previousSnapshot.contractSnapshot.dfidToken.balances[dfidTokenAddress] || BigInt(0);
        const newContractRewardTokenBalance = newSnapshot.contractSnapshot.dfidToken.balances[dfidTokenAddress] || BigInt(0);

        if (reward > BigInt(0)) {
          expect(previousContractRewardTokenBalance - newContractRewardTokenBalance).to.equal(reward, "Contract's reward token balance should decrease by the reward amount");
        }


        return true;
    }
}
