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
        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;

        // Parameter Generation
        const actorAddress = actor.account.address;
        const actorDfidBalance = dfidTokenSnapshot.balances[actorAddress] || BigInt(0);

        // Ensure _amount is within the actor's DFID balance
        const maxStakeAmount = actorDfidBalance > 10000n ? 10000n : actorDfidBalance; // Cap at 10000 for testing, or use full balance
        const _amount = maxStakeAmount > 0n ? BigInt(Math.floor(context.prng.next() % Number(maxStakeAmount)) + 1n) : 0n; // Ensure _amount > 0

        const frontend = ethers.ZeroAddress; // Or a valid address if needed
        const fee = BigInt(Math.floor(context.prng.next() % 10001)); // Fee between 0 and 10000

        if (_amount <= 0) {
            console.log(`Actor ${actorAddress} does not have enough DFID tokens to stake or stake is zero.`);
            return [false, {}, {}];
        }

        const params = {
            _amount: _amount,
            frontend: frontend,
            fee: fee,
        };

        return [true, params, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { _amount, frontend, fee } = actionParams;
        const tx = await this.contract.connect(actor.account.value).stake(_amount, frontend, fee);
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
        const { _amount, frontend, fee } = actionParams;
        const actorAddress = actor.account.address;

        const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

        const previousDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        // Stake Update validations
        const previousUserStake = previousStabilityPoolSnapshot.users[actorAddress]?.stake || BigInt(0);
        const newUserStake = newStabilityPoolSnapshot.users[actorAddress]?.stake || BigInt(0);

        expect(newUserStake).to.equal(previousUserStake + _amount, "User's stake should increase by _amount");

        const previousTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
        const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;
        expect(newTotalStakedRaw).to.equal(previousTotalStakedRaw + _amount, "totalStakedRaw should increase by _amount");

        // Token balance validations
        const previousActorDfidBalance = previousDfidTokenSnapshot.balances[actorAddress] || BigInt(0);
        const newActorDfidBalance = newDfidTokenSnapshot.balances[actorAddress] || BigInt(0);
        expect(newActorDfidBalance).to.equal(previousActorDfidBalance - _amount, "Actor's stakingToken balance should decrease by _amount");

        const stabilityPoolAddress = this.contract.target;
        const previousPoolDfidBalance = previousDfidTokenSnapshot.balances[stabilityPoolAddress] || BigInt(0);
        const newPoolDfidBalance = newDfidTokenSnapshot.balances[stabilityPoolAddress] || BigInt(0);
        expect(newPoolDfidBalance).to.equal(previousPoolDfidBalance + _amount, "StabilityPool's stakingToken balance should increase by _amount");

        //Check that stake scaling factor and stake reset count are updated
        expect(newStabilityPoolSnapshot.users[actorAddress].cumulativeProductScalingFactor).to.equal(newStabilityPoolSnapshot.stakeScalingFactor, "User cumulativeProductScalingFactor should be updated to current stakeScalingFactor");
        expect(newStabilityPoolSnapshot.users[actorAddress].stakeResetCount).to.equal(newStabilityPoolSnapshot.stakeResetCount, "User stakeResetCount should be updated to current stakeResetCount");

        // SBR Reward Distribution Status check, only if it was NOT_STARTED and is now STARTED it means it was updated
        if(previousStabilityPoolSnapshot.sbrRewardDistributionStatus === 0 && newStabilityPoolSnapshot.sbrRewardDistributionStatus === 1) {
          // Cannot accurately validate timestamp, as block.timestamp is only available during execution, so skipping timestamp validation.
        }

        return true;
    }
}
