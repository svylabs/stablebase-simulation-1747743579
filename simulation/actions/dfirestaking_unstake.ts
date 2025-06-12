import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from "chai";
import {ethers} from "ethers";

const PRECISION = 10n ** 18n; // Assuming PRECISION is 1e18 based on common smart contract practices

export class UnstakeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("UnstakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const userAddress = actor.account.address;

        // Get current staked amount for the user
        const userStake = currentSnapshot.contractSnapshot.dfireStaking.userStake.stake;

        // The '_amount' to unstake must be greater than zero.
        // The '_amount' to unstake must be less than or equal to the current staked amount of the user.
        if (userStake === 0n) {
            // Cannot unstake if the user has no stake
            return [false, {}, {}];
        }

        // Generate a random amount to unstake, between 1 and userStake (inclusive)
        // context.prng.next() gives a number between [0, 2^32 - 1].
        // To get a random BigInt up to userStake, we can use modulo and add 1n to ensure it's > 0.
        // If userStake is N, (context.prng.next() % N) gives [0, N-1]. Adding 1 gives [1, N].
        const _amount = (BigInt(context.prng.next()) % userStake) + 1n;

        const actionParams = {
            _amount: _amount,
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value;
        const unstakeAmount = actionParams._amount;

        const tx = await this.contract.connect(signer).unstake(unstakeAmount);
        const receipt = await tx.wait();
        expect(receipt).to.not.be.null;

        return receipt!;
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
        const dfireStakingAddress = context.contracts.dfireStaking.target as string;
        const dfidTokenAddress = context.contracts.dfidToken.target as string;
        const dfireTokenAddress = context.contracts.dfireToken.target as string;
        const stableBaseCDPAddress = context.contracts.stableBaseCDP.target as string;

        const unstakeAmount = actionParams._amount;

        // Calculate gas fee
        const gasUsed = BigInt(executionReceipt.gasUsed);
        const effectiveGasPrice = BigInt(executionReceipt.effectiveGasPrice);
        const gasFee = gasUsed * effectiveGasPrice;

        // --- State Variables from previous snapshot for calculations ---
        const prevUserStake = previousSnapshot.contractSnapshot.dfireStaking.userStake.stake;
        const prevUserRewardSnapshot = previousSnapshot.contractSnapshot.dfireStaking.userStake.rewardSnapshot;
        const prevUserCollateralSnapshot = previousSnapshot.contractSnapshot.dfireStaking.userStake.collateralSnapshot;
        const prevTotalStake = previousSnapshot.contractSnapshot.dfireStaking.totalStake;
        const prevTotalRewardPerToken = previousSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;
        const prevTotalCollateralPerToken = previousSnapshot.contractSnapshot.dfireStaking.totalCollateralPerToken;
        const prevRewardSenderActive = previousSnapshot.contractSnapshot.dfireStaking.rewardSenderActive;

        // --- Expected changes based on _claim logic (internal to unstake) ---
        let expectedReward = (prevTotalRewardPerToken - prevUserRewardSnapshot) * prevUserStake / PRECISION;
        let expectedCollateralReward = (prevTotalCollateralPerToken - prevUserCollateralSnapshot) * prevUserStake / PRECISION;

        // Ensure non-negative rewards (though typically they should be positive or zero)
        if (expectedReward < 0n) expectedReward = 0n;
        if (expectedCollateralReward < 0n) expectedCollateralReward = 0n;

        // --- DFIREStaking Contract State Validation ---
        const newUserStake = newSnapshot.contractSnapshot.dfireStaking.userStake.stake;
        const newTotalStake = newSnapshot.contractSnapshot.dfireStaking.totalStake;
        const newUserRewardSnapshot = newSnapshot.contractSnapshot.dfireStaking.userStake.rewardSnapshot;
        const newUserCollateralSnapshot = newSnapshot.contractSnapshot.dfireStaking.userStake.collateralSnapshot;
        const newTotalRewardPerToken = newSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken; // For snapshot comparison
        const newTotalCollateralPerToken = newSnapshot.contractSnapshot.dfireStaking.totalCollateralPerToken; // For snapshot comparison

        expect(newUserStake, "User's stake must decrease by amount").to.equal(prevUserStake - unstakeAmount);
        expect(newTotalStake, "Total stake must decrease by amount").to.equal(prevTotalStake - unstakeAmount);

        // The user's reward snapshot (stakes[msg.sender].rewardSnapshot) is updated to the current totalRewardPerToken.
        expect(newUserRewardSnapshot, "User reward snapshot must update to new totalRewardPerToken").to.equal(newTotalRewardPerToken);
        // The user's collateral snapshot (stakes[msg.sender].collateralSnapshot) is updated to the current totalCollateralPerToken.
        expect(newUserCollateralSnapshot, "User collateral snapshot must update to new totalCollateralPerToken").to.equal(newTotalCollateralPerToken);

        // --- Token Balances Validation ---
        // DFIREToken balances
        const prevUserDFIREBalance = previousSnapshot.contractSnapshot.dfireToken.accounts[userAddress]?.balance || 0n;
        const newUserDFIREBalance = newSnapshot.contractSnapshot.dfireToken.accounts[userAddress]?.balance || 0n;
        const prevDFIREStakingDFIREBalance = previousSnapshot.contractSnapshot.dfireToken.accounts[dfireStakingAddress]?.balance || 0n;
        const newDFIREStakingDFIREBalance = newSnapshot.contractSnapshot.dfireToken.accounts[dfireStakingAddress]?.balance || 0n;

        expect(newUserDFIREBalance, "User DFIREToken balance must increase by unstaked amount").to.equal(prevUserDFIREBalance + unstakeAmount);
        expect(newDFIREStakingDFIREBalance, "DFIREStaking DFIREToken balance must decrease by unstaked amount").to.equal(prevDFIREStakingDFIREBalance - unstakeAmount);

        // DFIDToken balances (rewards)
        const prevUserDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[userAddress] || 0n;
        const newUserDFIDBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[userAddress] || 0n;
        const prevDFIREStakingDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[dfireStakingAddress] || 0n;
        const newDFIREStakingDFIDBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[dfireStakingAddress] || 0n;

        if (expectedReward > 0n) {
            expect(newUserDFIDBalance, "User DFIDToken balance must increase by reward amount").to.equal(prevUserDFIDBalance + expectedReward);
            expect(newDFIREStakingDFIDBalance, "DFIREStaking DFIDToken balance must decrease by reward amount").to.equal(prevDFIREStakingDFIDBalance - expectedReward);
        } else {
            expect(newUserDFIDBalance, "User DFIDToken balance should not change if reward is 0").to.equal(prevUserDFIDBalance);
            expect(newDFIREStakingDFIDBalance, "DFIREStaking DFIDToken balance should not change if reward is 0").to.equal(prevDFIREStakingDFIDBalance);
        }

        // Native currency (ETH) balances (collateral rewards)
        const prevUserETHBalance = previousSnapshot.accountSnapshot[userAddress] || 0n;
        const newUserETHBalance = newSnapshot.accountSnapshot[userAddress] || 0n;
        const prevDFIREStakingETHBalance = previousSnapshot.accountSnapshot[dfireStakingAddress] || 0n;
        const newDFIREStakingETHBalance = newSnapshot.accountSnapshot[dfireStakingAddress] || 0n;

        if (expectedCollateralReward > 0n) {
            expect(newUserETHBalance, "User ETH balance must increase by collateral reward minus gas").to.equal(prevUserETHBalance + expectedCollateralReward - gasFee);
            expect(newDFIREStakingETHBalance, "DFIREStaking ETH balance must decrease by collateral reward").to.equal(prevDFIREStakingETHBalance - expectedCollateralReward);
        } else {
            expect(newUserETHBalance, "User ETH balance should decrease only by gas fee if collateral reward is 0").to.equal(prevUserETHBalance - gasFee);
            expect(newDFIREStakingETHBalance, "DFIREStaking ETH balance should not change if collateral reward is 0").to.equal(prevDFIREStakingETHBalance);
        }

        // --- External Contract State (Conditional) Validation ---
        const prevCanSBRStakingPoolReceiveRewards = previousSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolRewardsEnabled;
        const newCanSBRStakingPoolReceiveRewards = newSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolRewardsEnabled;

        const wasTotalStakeZeroAfterUnstake = (prevTotalStake - unstakeAmount) === 0n;

        if (prevRewardSenderActive && wasTotalStakeZeroAfterUnstake) {
            expect(newCanSBRStakingPoolReceiveRewards, "StableBaseCDP.canSBRStakingPoolReceiveRewards must be false").to.be.false;
        } else {
            expect(newCanSBRStakingPoolReceiveRewards, "StableBaseCDP.canSBRStakingPoolReceiveRewards should remain unchanged").to.equal(prevCanSBRStakingPoolReceiveRewards);
        }

        // --- Event Validation ---
        const unstakedEvent = executionReceipt.events?.find(e => e.event === "Unstaked");
        expect(unstakedEvent, "Unstaked event must be emitted").to.not.be.undefined;
        expect(unstakedEvent?.args?.user, "Unstaked event user must match sender").to.equal(userAddress);
        expect(unstakedEvent?.args?.amount, "Unstaked event amount must match unstaked amount").to.equal(unstakeAmount);

        const claimedEvent = executionReceipt.events?.find(e => e.event === "Claimed");
        expect(claimedEvent, "Claimed event must be emitted").to.not.be.undefined;
        expect(claimedEvent?.args?.user, "Claimed event user must match sender").to.equal(userAddress);
        expect(claimedEvent?.args?.rewardAmount, "Claimed event rewardAmount must match calculated reward").to.equal(expectedReward);
        expect(claimedEvent?.args?.collateralReward, "Claimed event collateralReward must match calculated collateral reward").to.equal(expectedCollateralReward);

        return true;
    }
}
