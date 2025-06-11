import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { expect } from 'chai';
import { ethers } from 'ethers';

export class UnstakeAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("UnstakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        frontendAddress?: string,
        fee?: bigint
    ): Promise<[boolean, any, Record<string, any>]> {
        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
        const userAddress = actor.account.address;
        const userStake = stabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);

        if (userStake <= BigInt(0)) {
            return [false, {}, {}];
        }

        const amountToUnstake = BigInt(Math.floor(context.prng.next() % Number(userStake + BigInt(1))));

        if (amountToUnstake <= BigInt(0)) {
            return [false, {}, {}];
        }


        const actionParams = {
            amount: amountToUnstake,
            frontend: frontendAddress || ethers.ZeroAddress,
            fee: fee || BigInt(0),
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { amount, frontend, fee } = actionParams;
        const tx = await this.contract.connect(actor.account.value).unstake(amount, frontend, fee);
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
        const { amount, frontend, fee } = actionParams;
        const userAddress = actor.account.address;

        const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const previousUserStake = previousStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);
        const newUserStake = newStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);

        const previousTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
        const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;

        const previousUserDFIDBalance = previousDFIDTokenSnapshot.balances[userAddress] || BigInt(0);
        const newUserDFIDBalance = newDFIDTokenSnapshot.balances[userAddress] || BigInt(0);

        // Stake Updates
        expect(newUserStake, "User stake should decrease by amount").to.equal(previousUserStake - amount);
        expect(newTotalStakedRaw, "Total staked raw should decrease by amount").to.equal(previousTotalStakedRaw - amount);

        // Token Transfer
        expect(newUserDFIDBalance, "User should receive unstaked tokens").to.equal(previousUserDFIDBalance + amount);

        // Check if totalStakedRaw becomes zero and validate the external call
        if (previousTotalStakedRaw !== BigInt(0) && newTotalStakedRaw === BigInt(0) && previousStabilityPoolSnapshot.rewardSenderActive) {
            expect(newStabilityPoolSnapshot.rewardSenderActive).to.be.false;
        }

        // Check for event emitted
        const unstakedEvent = executionReceipt.receipt.logs.find(
            (log: any) => log.address === this.contract.target && this.contract.interface.parseLog(log)?.name === "Unstaked"
        );
        expect(unstakedEvent).to.not.be.undefined;

         //Reward Claimed event validation
        const rewardClaimedEvent = executionReceipt.receipt.logs.find(
            (log: any) => log.address === this.contract.target && this.contract.interface.parseLog(log)?.name === "RewardClaimed"
        );

        if(rewardClaimedEvent){
            const parsedEvent = this.contract.interface.parseLog(rewardClaimedEvent).args;
            expect(parsedEvent).to.not.be.undefined;
            expect(parsedEvent.user).to.equal(userAddress);

            // Add more validation for reward, rewardFee, collateral, collateralFee if needed.
        }

        // DFireRewardClaimed event validation (SBR rewards)
        const dFireRewardClaimedEvent = executionReceipt.receipt.logs.find(
            (log: any) => log.address === this.contract.target && this.contract.interface.parseLog(log)?.name === "DFireRewardClaimed"
        );

        if (dFireRewardClaimedEvent) {
          const parsedEvent = this.contract.interface.parseLog(dFireRewardClaimedEvent).args;

          expect(parsedEvent).to.not.be.undefined;
          expect(parsedEvent.user).to.equal(userAddress);
        }

        return true;
    }
}
