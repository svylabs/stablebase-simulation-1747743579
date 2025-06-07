import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';

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
    ): Promise<[any, Record<string, any>]> {
        // No parameters needed for claim function
        return [[], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const tx = await this.contract.connect(actor.account.value).claim();
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const previousDFIREStaking = previousSnapshot.contractSnapshot.dfireStaking;
        const newDFIREStaking = newSnapshot.contractSnapshot.dfireStaking;
        const previousDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;

        const actorAddress = actor.account.address;
        const previousStake = previousDFIREStaking.stakesMapping[actorAddress] || { stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0) };
        const newStake = newDFIREStaking.stakesMapping[actorAddress] || { stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0) };

        const previousTotalRewardPerToken = previousDFIREStaking.totalRewardPerToken;
        const newTotalRewardPerToken = newDFIREStaking.totalRewardPerToken;
        const previousTotalCollateralPerToken = previousDFIREStaking.totalCollateralPerToken;
        const newTotalCollateralPerToken = newDFIREStaking.totalCollateralPerToken;

        const previousAccountBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);

        const previousDFIDTokenBalance = previousDFIDToken.balances?.[actorAddress] || BigInt(0);
        const newDFIDTokenBalance = newDFIDToken.balances?.[actorAddress] || BigInt(0);

        const precision = BigInt(10)**BigInt(18); // Assuming 18 decimals, as is typical for ERC20 tokens

        const reward = ((newTotalRewardPerToken - previousStake.rewardSnapshot) * previousStake.stake) / precision;
        const collateralReward = ((newTotalCollateralPerToken - previousStake.collateralSnapshot) * previousStake.stake) / precision;

        // Staking State Validation
        expect(newStake.rewardSnapshot).to.equal(newTotalRewardPerToken, "User's rewardSnapshot should be updated to totalRewardPerToken.");
        expect(newStake.collateralSnapshot).to.equal(newTotalCollateralPerToken, "User's collateralSnapshot should be updated to totalCollateralPerToken.");

        // Reward Token Balance Validation
        if (reward > 0) {
            expect(newDFIDTokenBalance).to.equal(previousDFIDTokenBalance + reward, "User's reward token (DFIDToken) balance should increase by the reward amount.");
        }

        // Collateral Balance Validation
        if (collateralReward > 0) {
            expect(newAccountBalance).to.equal(previousAccountBalance + collateralReward, "User's ETH balance should increase by the collateralReward amount.");
        }

        // Check event emission
        // This is more complex and requires access to the transaction receipt, which
        // is not directly available in the validate function.
        // A more robust validation would involve checking for the emitted event
        // using a provider and filtering for the specific event.

        return true;
    }
}
