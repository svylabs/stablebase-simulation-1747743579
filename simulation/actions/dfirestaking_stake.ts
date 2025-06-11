import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class StakeAction extends Action {
    contract: ethers.Contract;

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

        const actorDfireBalance = dfireTokenSnapshot.tokenBalances[actorAddress] || BigInt(0);
        if (actorDfireBalance <= BigInt(0)) {
            console.log("StakeAction: Actor has insufficient DFIRE tokens to stake.");
            return [false, {}, {}];
        }

        // Generate a random amount within the actor's DFIRE balance.
        const amount = BigInt(Math.floor(context.prng.next() % Number(actorDfireBalance)));
        if (amount <= BigInt(0)) {
            console.log("StakeAction: Amount must be greater than 0.");
            return [false, {}, {}];
        }

        const actionParams = {
            _amount: amount,
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { _amount } = actionParams;

        const tx = await this.contract.connect(actor.account.value).stake(_amount);
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
        const { _amount } = actionParams;
        const actorAddress = actor.account.address;
        const contractAddress = this.contract.target;

        const previousDfireStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;
        const previousDfireTokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
        const newDfireTokenSnapshot = newSnapshot.contractSnapshot.dfireToken;
        const previousDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        // Stake Update
        const previousStake = previousDfireStakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);
        const newStake = newDfireStakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);

        expect(newStake).to.equal(previousStake + _amount, "Stake amount should be increased by _amount");
        expect(newDfireStakingSnapshot.stakes[actorAddress].rewardSnapshot).to.equal(newDfireStakingSnapshot.totalRewardPerToken, "rewardSnapshot should be updated to totalRewardPerToken");
        expect(newDfireStakingSnapshot.stakes[actorAddress].collateralSnapshot).to.equal(newDfireStakingSnapshot.totalCollateralPerToken, "collateralSnapshot should be updated to totalCollateralPerToken");
        expect(newDfireStakingSnapshot.totalStake).to.equal(previousDfireStakingSnapshot.totalStake + _amount, "totalStake should be increased by _amount");

        // Token Transfers - DFIREToken (stakingToken)
        expect(newDfireTokenSnapshot.tokenBalances[contractAddress]).to.equal(
            (previousDfireTokenSnapshot.tokenBalances[contractAddress] || BigInt(0)) + _amount,
            "DFIREStaking contract balance should increase by _amount"
        );
        expect(newDfireTokenSnapshot.tokenBalances[actorAddress]).to.equal(
            previousDfireTokenSnapshot.tokenBalances[actorAddress] - _amount,
            "Actor's DFIREToken balance should decrease by _amount"
        );

        // Reward Claim Validation (checking if reward was claimed during stake)
        // Assuming reward is transferred only during the stake call
        let reward = BigInt(0);
        let collateralReward = BigInt(0);

        const previousRewardSnapshot = previousDfireStakingSnapshot.stakes[actorAddress]?.rewardSnapshot || BigInt(0);
        const previousCollateralSnapshot = previousDfireStakingSnapshot.stakes[actorAddress]?.collateralSnapshot || BigInt(0);
        const stakeBefore = previousDfireStakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);

        if (_amount > 0 && previousDfireStakingSnapshot.totalRewardPerToken > previousRewardSnapshot) {
            reward = ((previousDfireStakingSnapshot.totalRewardPerToken - previousRewardSnapshot) * stakeBefore) / previousDfireStakingSnapshot.precision;
        }

        if (_amount > 0 && previousDfireStakingSnapshot.totalCollateralPerToken > previousCollateralSnapshot) {
            collateralReward = ((previousDfireStakingSnapshot.totalCollateralPerToken - previousCollateralSnapshot) * stakeBefore) / previousDfireStakingSnapshot.precision;
        }

        if (reward > 0n) {
            expect(newDfidTokenSnapshot.balances[actorAddress]).to.equal(
                previousDfidTokenSnapshot.balances[actorAddress] + reward,
                "DFIDToken balance of actor should increase by reward amount"
            );
        }

        const prevAccountBalance = previousSnapshot.accountSnapshot[actorAddress] || 0n;
        const newAccountBalance = newSnapshot.accountSnapshot[actorAddress] || 0n;
        if (collateralReward > 0n) {
            expect(newAccountBalance - prevAccountBalance).to.equal(
                collateralReward,
                "ETH balance of actor should increase by collateralReward amount"
            );
        }

        return true;
    }
}
