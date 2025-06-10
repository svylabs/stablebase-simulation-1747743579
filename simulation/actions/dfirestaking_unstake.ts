import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class UnstakeAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("UnstakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const dfireStakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
        const stake = dfireStakingSnapshot.stakeByUser[actor.account.address]?.stake || BigInt(0);

        if (stake <= BigInt(0)) {
            return [false, {}, {}];
        }

        const maxUnstakeAmount = stake;

        const amountToUnstake = BigInt(Math.floor(context.prng.next() % Number(maxUnstakeAmount + BigInt(1))));

        if (amountToUnstake <= BigInt(0)) {
          return [false, {}, {}];
        }

        const params = {
            _amount: amountToUnstake,
        };

        return [true, params, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { _amount } = actionParams;
        const tx = await this.contract.connect(actor.account.value).unstake(_amount);
        return { txHash: tx.hash };
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

        const previousDfireStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;
        const previousDfireTokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
        const newDfireTokenSnapshot = newSnapshot.contractSnapshot.dfireToken;

        const previousStake = previousDfireStakingSnapshot.stakeByUser[actor.account.address]?.stake || BigInt(0);
        const newStake = newDfireStakingSnapshot.stakeByUser[actor.account.address]?.stake || BigInt(0);

        const previousTotalStake = previousDfireStakingSnapshot.totalStake;
        const newTotalStake = newDfireStakingSnapshot.totalStake;

        const previousDfireBalance = previousDfireTokenSnapshot.balances[actor.account.address] || BigInt(0);
        const newDfireBalance = newDfireTokenSnapshot.balances[actor.account.address] || BigInt(0);

        // Staking and Token Balances
        expect(newStake, "User's stake should be decreased by the unstaked amount").to.equal(previousStake - _amount);
        expect(newTotalStake, "Total stake should be decreased by the unstaked amount").to.equal(previousTotalStake - _amount);
        expect(newDfireBalance, "User's DFIRE balance should increase by the unstaked amount").to.equal(previousDfireBalance + _amount);

        // System State
        if (previousTotalStake !== BigInt(0) && newTotalStake === BigInt(0) && previousDfireStakingSnapshot.rewardSenderActive) {
            expect(newSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolCanReceiveRewards, "rewardSenderActive should be false").to.be.false;
        } else {
            expect(newSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolCanReceiveRewards, "rewardSenderActive should remain unchanged").to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolCanReceiveRewards);
        }

        // Event Emission -  cannot check from snapshot, need to get it from the logs.
        // const unstakedEvent = executionReceipt.events?.find(e => e.name === "Unstaked");
        // expect(unstakedEvent, "Unstaked event should be emitted").to.not.be.undefined;

        return true;
    }
}
