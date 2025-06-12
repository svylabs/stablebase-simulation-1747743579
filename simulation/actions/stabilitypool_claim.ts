import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from 'chai';
import type { ethers } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Define StabilityPoolSBRRewardDistribution enum values as BigInts
const SBRRewardDistribution = {
    NOT_STARTED: 0n,
    STARTED: 1n,
    ENDED: 2n,
    CLAIMED: 3n
};

// Define constants from contract context
const PRECISION = 10n**18n;
const BASIS_POINTS_DIVISOR = 10000n;

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
        const userAddress = actor.account.address;
        const userStabilityPoolInfo = currentSnapshot.contractSnapshot.stabilityPool.users[userAddress];

        // The claim() function checks if user.stake > 0.
        // If the user has no stake, the action cannot be executed.
        if (!userStabilityPoolInfo || userStabilityPoolInfo.stake === 0n) {
            context.log.info(`ClaimAction: User ${userAddress} has no stake or no info, cannot claim.`);
            return [false, {}, {}];
        }

        context.log.info(`ClaimAction: User ${userAddress} has stake ${userStabilityPoolInfo.stake}, proceeding to claim.`);
        // The claim() function takes no parameters.
        return [true, {}, {}]; // No parameters needed for claim()
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        context.log.info(`Executing Claim action for user ${actor.account.address}`);
        const signer = actor.account.value as HardhatEthersSigner;
        
        // Call the claim() function on the StabilityPool contract
        const tx = await this.contract.connect(signer).claim();
        const receipt = await tx.wait();
        context.log.info(`Claim action transaction hash: ${receipt.hash}`);
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
        context.log.info(`Validating Claim action for user ${actor.account.address}`);
        const userAddress = actor.account.address;
        const currentTimestamp = BigInt(executionReceipt.blockTimestamp);

        const previousUser = previousSnapshot.contractSnapshot.stabilityPool.users[userAddress];
        const newUser = newSnapshot.contractSnapshot.stabilityPool.users[userAddress];

        const previousSBRSnapshot = previousSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[userAddress];
        const newSBRSnapshot = newSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[userAddress];

        const previousPool = previousSnapshot.contractSnapshot.stabilityPool;
        const newPool = newSnapshot.contractSnapshot.stabilityPool;

        const previousDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[userAddress] || 0n;
        const newDFIDBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[userAddress] || 0n;

        const previousDFIREBalance = previousSnapshot.contractSnapshot.dfireToken.accounts[userAddress]?.balance || 0n;
        const newDFIREBalance = newSnapshot.contractSnapshot.dfireToken.accounts[userAddress]?.balance || 0n;

        const previousDFIRETotalSupply = previousSnapshot.contractSnapshot.dfireToken.totalTokenSupply;
        const newDFIRETotalSupply = newSnapshot.contractSnapshot.dfireToken.totalTokenSupply;
        
        const previousETHBalance = previousSnapshot.accountSnapshot[userAddress] || 0n;
        const newETHBalance = newSnapshot.accountSnapshot[userAddress] || 0n;

        // Calculate gas cost (ethers.js returns gasUsed and gasPrice as BigInts)
        const gasUsed = executionReceipt.gasUsed * executionReceipt.gasPrice;

        // 1. Retrieve expected pending rewards, collateral, and SBR based on the previous snapshot
        // This data comes from the `userPendingRewardAndCollateral` view function in the StabilityPool contract.
        // Assuming this snapshot function returns the *gross* amounts before fees, and fees are 0 for claim() as per prompt.
        const [expectedPendingReward, expectedPendingCollateral, expectedPendingSbrRewards] = 
            previousSnapshot.contractSnapshot.stabilityPool.userPendingRewardAndCollateral[userAddress] || [0n, 0n, 0n];

        // 2. Validate User Specific State Updates within StabilityPool (users[msg.sender])
        expect(newUser.rewardSnapshot, "User's rewardSnapshot should be updated to current totalRewardPerToken").to.equal(newPool.totalRewardPerToken);
        expect(newUser.collateralSnapshot, "User's collateralSnapshot should be updated to current totalCollateralPerToken").to.equal(newPool.totalCollateralPerToken);
        expect(newUser.cumulativeProductScalingFactor, "User's cumulativeProductScalingFactor should be updated to current stakeScalingFactor").to.equal(newPool.stakeScalingFactor);
        expect(newUser.stakeResetCount, "User's stakeResetCount should be updated to current stakeResetCount").to.equal(newPool.stakeResetCount);
        
        // Implement _getUserEffectiveStake for validation purposes to check newUser.stake
        const _getUserEffectiveStake = (user: any, pool: any): bigint => {
            let stake: bigint;
            if (user.cumulativeProductScalingFactor === 0n) {
                // As per _updateUserStake, if cumulativeProductScalingFactor is 0, stake is not adjusted.
                return user.stake;
            }

            if (user.stakeResetCount === pool.stakeResetCount) {
                stake = (((user.stake * pool.stakeScalingFactor) * PRECISION) / user.cumulativeProductScalingFactor) / PRECISION;
            } else {
                const snapshot = pool.stakeResetSnapshots[Number(user.stakeResetCount)];
                stake = ((user.stake * snapshot.scalingFactor * PRECISION) / user.cumulativeProductScalingFactor) / PRECISION;

                if (user.stakeResetCount + 1n !== pool.stakeResetCount) {
                    const nextSnapshot = pool.stakeResetSnapshots[Number(user.stakeResetCount + 1n)];
                    stake = (stake * nextSnapshot.scalingFactor) / PRECISION;
                } else {
                    stake = (stake * pool.stakeScalingFactor) / PRECISION;
                }
            }
            return stake;
        };
        
        // Only adjust stake if `user.cumulativeProductScalingFactor` was not 0 prior to update
        if (previousUser.cumulativeProductScalingFactor !== 0n) {
            const expectedEffectiveStake = _getUserEffectiveStake(previousUser, previousPool);
            expect(newUser.stake, "User's stake should be updated to its calculated effective stake").to.equal(expectedEffectiveStake);
        } else {
             // If cumulativeProductScalingFactor was 0, _updateUserStake does not modify `user.stake`.
             expect(newUser.stake, "User's stake should not change if cumulativeProductScalingFactor was 0").to.equal(previousUser.stake);
        }

        // 3. Validate SBR Reward Snapshots (sbrRewardSnapshots[msg.sender])
        if (previousPool.sbrRewardDistributionStatus !== SBRRewardDistribution.ENDED) {
            // If SBR distribution is not ended, rewardSnapshot should be updated.
            expect(newSBRSnapshot?.rewardSnapshot, "User's SBR rewardSnapshot updated").to.equal(newPool.totalSbrRewardPerToken);
        } else if (previousSBRSnapshot?.status !== SBRRewardDistribution.CLAIMED) {
            // If SBR distribution ended and not yet claimed, status should be CLAIMED.
            expect(newSBRSnapshot?.status, "User's SBR reward status set to CLAIMED").to.equal(SBRRewardDistribution.CLAIMED);
        }

        // 4. Validate Balance Updates for Claiming User
        // Fees are 0 for the external claim() function.
        expect(newDFIDBalance, "DFID Token balance should increase by pending reward").to.equal(previousDFIDBalance + expectedPendingReward);
        expect(newETHBalance, "Native Token balance should increase by pending collateral minus gas cost").to.equal(previousETHBalance + expectedPendingCollateral - gasUsed);
        expect(newDFIREBalance, "DFIRE Token balance should increase by pending SBR rewards").to.equal(previousDFIREBalance + expectedPendingSbrRewards);
        expect(newDFIRETotalSupply, "DFIRE Token total supply should increase by pending SBR rewards").to.equal(previousDFIRETotalSupply + expectedPendingSbrRewards);

        // 5. Validate Protocol-Wide SBR Reward Distribution Updates
        let expectedLastSBRRewardDistributedTime = previousPool.lastSBRRewardDistributedTime;
        let expectedSbrRewardDistributionStatus = previousPool.sbrRewardDistributionStatus;
        let expectedSbrRewardDistributionEndTime = previousPool.sbrRewardDistributionEndTime;
        let expectedTotalSbrRewardPerToken = previousPool.totalSbrRewardPerToken;
        let expectedSbrRewardLoss = previousPool.sbrRewardLoss;
        let expectedSbrRewardsAddedEventAmount = 0n; // Corresponds to `sbrReward` in Solidity's _addSBRRewards

        // The _addSBRRewards function is called if sbrRewardDistributionStatus is not ENDED
        if (previousPool.sbrRewardDistributionStatus !== SBRRewardDistribution.ENDED) {
            // lastSBRRewardDistributedTime is always updated to currentTimestamp if _addSBRRewards is called
            expectedLastSBRRewardDistributedTime = currentTimestamp;

            if (previousPool.sbrRewardDistributionStatus === SBRRewardDistribution.STARTED) {
                let timeElapsed = currentTimestamp - previousPool.lastSBRRewardDistributedTime;

                // Handle potential status change within _addSBRRewards due to end time
                if (currentTimestamp > previousPool.sbrRewardDistributionEndTime) {
                    expectedSbrRewardDistributionStatus = SBRRewardDistribution.ENDED;
                    timeElapsed = previousPool.sbrRewardDistributionEndTime - previousPool.lastSBRRewardDistributedTime;
                }

                expectedSbrRewardsAddedEventAmount = timeElapsed * previousPool.sbrDistributionRate;

                if (previousPool.totalStakedRaw > 0n) {
                    const _sbrRewardWithLoss = expectedSbrRewardsAddedEventAmount + previousPool.sbrRewardLoss;
                    const _totalSbrRewardPerTokenIncrease = ((_sbrRewardWithLoss * previousPool.stakeScalingFactor * PRECISION) / previousPool.totalStakedRaw) / PRECISION;
                    expectedTotalSbrRewardPerToken = previousPool.totalSbrRewardPerToken + _totalSbrRewardPerTokenIncrease;
                    expectedSbrRewardLoss = _sbrRewardWithLoss - ((_totalSbrRewardPerTokenIncrease * previousPool.totalStakedRaw * PRECISION) / previousPool.stakeScalingFactor) / PRECISION;
                }
            } else if (previousPool.sbrRewardDistributionStatus === SBRRewardDistribution.NOT_STARTED) {
                // When NOT_STARTED, it transitions to STARTED, sets end time, but doesn't update totalSbrRewardPerToken or sbrRewardLoss yet.
                expectedSbrRewardDistributionStatus = SBRRewardDistribution.STARTED;
                expectedSbrRewardDistributionEndTime = currentTimestamp + (365n * 24n * 60n * 60n); // 365 days in seconds
            }
        }

        expect(newPool.lastSBRRewardDistributedTime, "lastSBRRewardDistributedTime mismatch").to.equal(expectedLastSBRRewardDistributedTime);
        expect(newPool.sbrRewardDistributionStatus, "sbrRewardDistributionStatus mismatch").to.equal(expectedSbrRewardDistributionStatus);
        expect(newPool.sbrRewardDistributionEndTime, "sbrRewardDistributionEndTime mismatch").to.equal(expectedSbrRewardDistributionEndTime);
        expect(newPool.totalSbrRewardPerToken, "totalSbrRewardPerToken mismatch").to.equal(expectedTotalSbrRewardPerToken);
        expect(newPool.sbrRewardLoss, "sbrRewardLoss mismatch").to.equal(expectedSbrRewardLoss);

        // 6. Validate Event Emissions
        const rewardClaimedEvent = executionReceipt.events?.find(e => e.eventName === 'RewardClaimed');
        expect(rewardClaimedEvent, "RewardClaimed event must be emitted").to.exist;
        expect(rewardClaimedEvent?.args?.user, "RewardClaimed: user address mismatch").to.equal(userAddress);
        expect(rewardClaimedEvent?.args?.totalReward, "RewardClaimed: total reward mismatch").to.equal(expectedPendingReward);
        expect(rewardClaimedEvent?.args?.rewardFrontendFee, "RewardClaimed: reward frontend fee should be 0").to.equal(0n);
        expect(rewardClaimedEvent?.args?.totalCollateral, "RewardClaimed: total collateral mismatch").to.equal(expectedPendingCollateral);
        expect(rewardClaimedEvent?.args?.collateralFrontendFee, "RewardClaimed: collateral frontend fee should be 0").to.equal(0n);

        if (expectedPendingSbrRewards > 0n) {
            const dfireRewardClaimedEvent = executionReceipt.events?.find(e => e.eventName === 'DFireRewardClaimed');
            expect(dfireRewardClaimedEvent, "DFireRewardClaimed event must be emitted if SBR rewards are claimed").to.exist;
            expect(dfireRewardClaimedEvent?.args?.user, "DFireRewardClaimed: user address mismatch").to.equal(userAddress);
            expect(dfireRewardClaimedEvent?.args?.amount, "DFireRewardClaimed: amount mismatch").to.equal(expectedPendingSbrRewards);
            expect(dfireRewardClaimedEvent?.args?.frontendFee, "DFireRewardClaimed: frontend fee should be 0").to.equal(0n);
        } else {
            expect(executionReceipt.events?.find(e => e.eventName === 'DFireRewardClaimed'), "DFireRewardClaimed event should not be emitted if no SBR rewards").to.not.exist;
        }

        const sbrRewardsAddedEvent = executionReceipt.events?.find(e => e.eventName === 'SBRRewardsAdded');
        // The SBRRewardsAdded event is emitted only if _addSBRRewards is called AND (sbrRewardDistributionStatus was STARTED AND totalStakedRaw > 0)
        if (previousPool.sbrRewardDistributionStatus === SBRRewardDistribution.STARTED && previousPool.totalStakedRaw > 0n) {
            expect(sbrRewardsAddedEvent, "SBRRewardsAdded event must be emitted if SBR rewards were added").to.exist;
            expect(sbrRewardsAddedEvent?.args?.lastTime, "SBRRewardsAdded: lastTime mismatch").to.equal(previousPool.lastSBRRewardDistributedTime);
            expect(sbrRewardsAddedEvent?.args?.currentTime, "SBRRewardsAdded: currentTime mismatch").to.equal(currentTimestamp);
            expect(sbrRewardsAddedEvent?.args?.rewardAmount, "SBRRewardsAdded: rewardAmount mismatch").to.equal(expectedSbrRewardsAddedEventAmount);
            expect(sbrRewardsAddedEvent?.args?.totalRewardPerToken, "SBRRewardsAdded: totalRewardPerToken mismatch").to.equal(expectedTotalSbrRewardPerToken);
        } else {
            expect(sbrRewardsAddedEvent, "SBRRewardsAdded event should not be emitted if no SBR rewards were added").to.not.exist;
        }

        return true;
    }
}
