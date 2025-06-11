import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class StakeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("StakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const dfireTokenSnapshot = currentSnapshot.contractSnapshot.dfireToken;
        const actorAddress = actor.account.address;

        if (!dfireTokenSnapshot.balances[actorAddress] || dfireTokenSnapshot.balances[actorAddress] === BigInt(0)) {
            return [false, {}, {}];
        }

        const amount = BigInt(Math.floor(context.prng.next() % Number(dfireTokenSnapshot.balances[actorAddress])));

        if (amount <= BigInt(0)) {
             return [false, {}, {}];
        }

        const actionParams = {
            _amount: amount
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value.connect(this.contract.runner! as any);
        const tx = await this.contract.stake(actionParams._amount);
        const receipt = await tx.wait();
        return { transactionHash: tx.hash, receipt };
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const actorAddress = actor.account.address;
        const amount = actionParams._amount;

        const previousDfireStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

        const previousDfireTokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
        const newDfireTokenSnapshot = newSnapshot.contractSnapshot.dfireToken;

        const previousDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const previousAccountBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);

        // Stake Update validations
        const previousStake = previousDfireStakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);
        const newStake = newDfireStakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);
        expect(newStake).to.equal(previousStake + amount, "Stake amount should be increased by _amount");

        expect(newDfireStakingSnapshot.stakes[actorAddress]?.rewardSnapshot).to.equal(newDfireStakingSnapshot.totalRewardPerTokenValue, "rewardSnapshot should be equal to totalRewardPerToken");
        expect(newDfireStakingSnapshot.stakes[actorAddress]?.collateralSnapshot).to.equal(newDfireStakingSnapshot.totalCollateralPerTokenValue, "collateralSnapshot should be equal to totalCollateralPerToken");

        const previousTotalStake = previousDfireStakingSnapshot.totalStakeValue;
        const newTotalStake = newDfireStakingSnapshot.totalStakeValue;
        expect(newTotalStake).to.equal(previousTotalStake + amount, "totalStake should be increased by _amount");


        // Token Transfer validations
        const previousStakingTokenBalance = previousDfireTokenSnapshot.balances[context.contracts.dfireStaking.target] || BigInt(0);
        const newStakingTokenBalance = newDfireTokenSnapshot.balances[context.contracts.dfireStaking.target] || BigInt(0);
        expect(newStakingTokenBalance).to.equal(previousStakingTokenBalance + amount, "stakingToken.balanceOf(address(this)) should increase by _amount");

        const previousUserTokenBalance = previousDfireTokenSnapshot.balances[actorAddress] || BigInt(0);
        const newUserTokenBalance = newDfireTokenSnapshot.balances[actorAddress] || BigInt(0);
        expect(newUserTokenBalance).to.equal(previousUserTokenBalance - amount, "stakingToken.balanceOf(msg.sender) should decrease by _amount");

        // Reward Claim Validations
        const previousRewardSnapshot = previousDfireStakingSnapshot.stakes[actorAddress]?.rewardSnapshot || BigInt(0);
        const previousCollateralSnapshot = previousDfireStakingSnapshot.stakes[actorAddress]?.collateralSnapshot || BigInt(0);

        const reward = ((newDfireStakingSnapshot.totalRewardPerTokenValue - previousRewardSnapshot) * previousStake) / previousDfireStakingSnapshot.precisionValue;
        const collateralReward = ((newDfireStakingSnapshot.totalCollateralPerTokenValue - previousCollateralSnapshot) * previousStake) / previousDfireStakingSnapshot.precisionValue;

        if (reward > 0) {
            const previousRewardTokenBalance = previousDfidTokenSnapshot.balances[actorAddress] || BigInt(0);
            const newRewardTokenBalance = newDfidTokenSnapshot.balances[actorAddress] || BigInt(0);
            expect(newRewardTokenBalance).to.equal(previousRewardTokenBalance + reward, "rewardToken.balanceOf(msg.sender) should increase by reward");
        }

        if (collateralReward > 0) {
            expect(newAccountBalance).to.be.gte(previousAccountBalance + collateralReward, "msg.sender ETH balance should increase by collateralReward");
        }

        //Reward Sender Activation
        if (previousDfireStakingSnapshot.isRewardSenderActive && previousDfireStakingSnapshot.totalStakeValue === BigInt(0)) {
          expect((newSnapshot.contractSnapshot.stableBaseCDP as any).sbrStakingPoolCanReceiveRewards).to.be.true
        }

        return true;
    }
}
