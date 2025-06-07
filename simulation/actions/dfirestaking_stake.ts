import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
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
    ): Promise<[any, Record<string, any>]> {
        const dfireTokenSnapshot = currentSnapshot.contractSnapshot.dfireToken;
        const actorAddress = actor.account.address;

        // Get the user's balance from the snapshot
        const userBalance = dfireTokenSnapshot.Balance[actorAddress] || BigInt(0);

        // Ensure user has a balance to stake
        if (userBalance === BigInt(0)) {
            throw new Error("User has no DFIRE tokens to stake");
        }

        // Generate a random amount to stake, but ensure it's within the user's balance
        const maxStakeAmount = userBalance > BigInt(1000) ? BigInt(1000) : userBalance;
        const amountToStake = BigInt(context.prng.next()) % maxStakeAmount + BigInt(1);

        const params = [amountToStake];
        return [params, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const signer = actor.account.value as ethers.Signer;
        const tx = await this.contract.connect(signer).stake(actionParams[0]);
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const amount = actionParams[0] as bigint;
        const actorAddress = actor.account.address;

        // Previous state
        const previousDfireStakingState = previousSnapshot.contractSnapshot.dfireStaking;
        const previousDfireTokenState = previousSnapshot.contractSnapshot.dfireToken;
        const previousDfidTokenState = previousSnapshot.contractSnapshot.dfidToken;

        const previousUserStake = previousDfireStakingState.stakes[actorAddress]?.stake || BigInt(0);
        const previousTotalStake = previousDfireStakingState.totalStake;
        const previousUserDfireBalance = previousDfireTokenState.Balance[actorAddress] || BigInt(0);
        const previousUserDfidBalance = previousDfidTokenState.Balance[actorAddress] || BigInt(0);

        // New state
        const newDfireStakingState = newSnapshot.contractSnapshot.dfireStaking;
        const newDfireTokenState = newSnapshot.contractSnapshot.dfireToken;
        const newDfidTokenState = newSnapshot.contractSnapshot.dfidToken;

        const newUserStake = newDfireStakingState.stakes[actorAddress]?.stake || BigInt(0);
        const newTotalStake = newDfireStakingState.totalStake;
        const newUserDfireBalance = newDfireTokenState.Balance[actorAddress] || BigInt(0);
        const newUserDfidBalance = newDfidTokenState.Balance[actorAddress] || BigInt(0);

        // Stake Update validations
        expect(newUserStake).to.equal(previousUserStake + amount, "User stake should increase by amount");
        expect(newTotalStake).to.equal(previousTotalStake + amount, "Total stake should increase by amount");

        //Staking Token balance validations
        expect(newUserDfireBalance).to.equal(previousUserDfireBalance - amount, "User DFIRE balance should decrease by amount");

        const stakingContractAddress = (context.contracts.dfireStaking as ethers.Contract).target;
        const previousContractDfireBalance = previousDfireTokenState.Balance[stakingContractAddress] || BigInt(0);
        const newContractDfireBalance = newDfireTokenState.Balance[stakingContractAddress] || BigInt(0);
        expect(newContractDfireBalance).to.equal(previousContractDfireBalance + amount, "Contract DFIRE balance should increase by amount");

        // Reward Claim Validations
        const rewardClaimed = newUserDfidBalance - previousUserDfidBalance;
        if (rewardClaimed > 0) {
            console.log("Reward Claimed: ", rewardClaimed);
        }

        return true;
    }
}
