import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

enum SBRRewardDistribution {
    NOT_STARTED,
    STARTED,
    ENDED,
    CLAIMED
}

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
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const userAddress = actor.account.address;

    if (!stabilityPoolSnapshot.userInfos[userAddress] || stabilityPoolSnapshot.userInfos[userAddress].stake === BigInt(0)) {
      return [false, {}, {}];
    }

    // No parameters needed for claim function
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
    const userAddress = actor.account.address;
    const previousStabilityPool = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPool = newSnapshot.contractSnapshot.stabilityPool;

    const previousDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;

    const previousDFIREToken = previousSnapshot.contractSnapshot.dfireToken;
    const newDFIREToken = newSnapshot.contractSnapshot.dfireToken;

    const previousAccountSnapshot = previousSnapshot.accountSnapshot;
    const newAccountSnapshot = newSnapshot.accountSnapshot;

    const previousETHBalance = previousAccountSnapshot[userAddress] || BigInt(0);
    const newETHBalance = newAccountSnapshot[userAddress] || BigInt(0);

    const previousUserInfo = previousStabilityPool.userInfos[userAddress];
    const newUserInfo = newStabilityPool.userInfos[userAddress];

    const BASIS_POINTS_DIVISOR = newStabilityPool.BASIS_POINTS_DIVISOR;

    // Validate stake, rewardSnapshot, collateralSnapshot, cumulativeProductScalingFactor, and stakeResetCount
    if (previousUserInfo && previousUserInfo.stake > BigInt(0)) {
      expect(newUserInfo.rewardSnapshot).to.equal(newStabilityPool.totalRewardPerToken, "rewardSnapshot should equal totalRewardPerToken");
      expect(newUserInfo.collateralSnapshot).to.equal(newStabilityPool.totalCollateralPerToken, "collateralSnapshot should equal totalCollateralPerToken");
      expect(newUserInfo.cumulativeProductScalingFactor).to.equal(newStabilityPool.stakeScalingFactor, "cumulativeProductScalingFactor should equal stakeScalingFactor");
      expect(newUserInfo.stakeResetCount).to.equal(newStabilityPool.stakeResetCount, "stakeResetCount should equal stakeResetCount");
    }

    // Validate SBR reward snapshots and status
    const previousSBRSnapshot = previousStabilityPool.sbrRewardSnapshots[userAddress];
        const newSBRSnapshot = newStabilityPool.sbrRewardSnapshots[userAddress];

        if (newStabilityPool.sbrRewardDistributionStatus !== "ENDED") {
            expect(newSBRSnapshot.rewardSnapshot).to.equal(newStabilityPool.totalSbrRewardPerToken, "sbrRewardSnapshots[msg.sender].rewardSnapshot should equal totalSbrRewardPerToken");
        } else {
            expect(newSBRSnapshot.status).to.equal(SBRRewardDistribution.CLAIMED, "sbrRewardSnapshots[msg.sender].status should be CLAIMED");
        }

    // Calculate pending rewards and collateral
    let pendingReward = BigInt(0);
    let pendingCollateral = BigInt(0);
    let pendingSbrRewards = BigInt(0);
    let rewardFee = BigInt(0);
    let collateralFee = BigInt(0);
    let sbrFee = BigInt(0);
    const frontendAddress = ethers.ZeroAddress; // Assuming no frontend
    let fee = BigInt(0);

        //Parameter generation based on snapshot data
        if (previousStabilityPool.totalStakedRaw > 0) {
           fee = BigInt(context.prng.next()) % (BASIS_POINTS_DIVISOR + BigInt(1)); // Ensure fee is within BASIS_POINTS_DIVISOR
        }

    if (previousUserInfo && previousUserInfo.cumulativeProductScalingFactor !== BigInt(0)) {
      const stakeResetCount = newStabilityPool.stakeResetCount;
      const userStakeResetCount = previousUserInfo.stakeResetCount;

      let pendingRewardVal: bigint;
      let pendingCollateralVal: bigint;
      let pendingSbrRewardsVal: bigint;

      const calculateSbrRewards = newStabilityPool.sbrRewardSnapshots[userAddress]?.status !== SBRRewardDistribution.CLAIMED;

      if (userStakeResetCount === stakeResetCount) {
        pendingRewardVal = (((newStabilityPool.totalRewardPerToken - previousUserInfo.rewardSnapshot) * previousUserInfo.stake) * newStabilityPool.precision) / previousUserInfo.cumulativeProductScalingFactor / newStabilityPool.precision;
        pendingCollateralVal = (((newStabilityPool.totalCollateralPerToken - previousUserInfo.collateralSnapshot) * previousUserInfo.stake) * newStabilityPool.precision) / previousUserInfo.cumulativeProductScalingFactor / newStabilityPool.precision;

        if (calculateSbrRewards) {
          pendingSbrRewardsVal = (((newStabilityPool.totalSbrRewardPerToken - (previousSBRSnapshot?.rewardSnapshot || BigInt(0))) * previousUserInfo.stake) * newStabilityPool.precision) / previousUserInfo.cumulativeProductScalingFactor / newStabilityPool.precision;
        }
      } else {
        const snapshot = newStabilityPool.stakeResetSnapshots[userStakeResetCount];
        pendingRewardVal = (((snapshot.totalRewardPerToken - previousUserInfo.rewardSnapshot) * previousUserInfo.stake) * newStabilityPool.precision) / previousUserInfo.cumulativeProductScalingFactor / newStabilityPool.precision;
        pendingCollateralVal = (((snapshot.totalCollateralPerToken - previousUserInfo.collateralSnapshot) * previousUserInfo.stake) * newStabilityPool.precision) / previousUserInfo.cumulativeProductScalingFactor / newStabilityPool.precision;

        if (calculateSbrRewards) {
          pendingSbrRewardsVal = (((snapshot.totalSBRRewardPerToken - (previousSBRSnapshot?.rewardSnapshot || BigInt(0))) * previousUserInfo.stake) * newStabilityPool.precision) / previousUserInfo.cumulativeProductScalingFactor / newStabilityPool.precision;
        }

        const userStake = (previousUserInfo.stake * snapshot.scalingFactor * newStabilityPool.precision) / previousUserInfo.cumulativeProductScalingFactor / newStabilityPool.precision;

        if (userStakeResetCount + 1 !== stakeResetCount) {
          const snapshot2 = newStabilityPool.stakeResetSnapshots[userStakeResetCount + 1];
          pendingRewardVal += (snapshot2.totalRewardPerToken * userStake) / newStabilityPool.precision;
          pendingCollateralVal += (snapshot2.totalCollateralPerToken * userStake) / newStabilityPool.precision;
          if (calculateSbrRewards) {
            pendingSbrRewardsVal += (snapshot2.totalSBRRewardPerToken * userStake) / newStabilityPool.precision;
          }
        } else {
          pendingRewardVal += (newStabilityPool.totalRewardPerToken * userStake) / newStabilityPool.precision;
          pendingCollateralVal += (newStabilityPool.totalCollateralPerToken * userStake) / newStabilityPool.precision;
          if (calculateSbrRewards) {
            pendingSbrRewardsVal += (newStabilityPool.totalSbrRewardPerToken * userStake) / newStabilityPool.precision;
          }
        }
      }

      pendingReward = pendingRewardVal > BigInt(0) ? pendingRewardVal : BigInt(0); // Avoid negative pendingReward
      pendingCollateral = pendingCollateralVal > BigInt(0) ? pendingCollateralVal : BigInt(0);
      pendingSbrRewards = pendingSbrRewardsVal > BigInt(0) ? pendingSbrRewardsVal : BigInt(0);

            rewardFee = (fee * pendingReward) / BASIS_POINTS_DIVISOR;
            collateralFee = (fee * pendingCollateral) / BASIS_POINTS_DIVISOR;
            sbrFee = (fee * pendingSbrRewards) / BASIS_POINTS_DIVISOR;
    }

        const expectedDFIDTokenBalanceChange = pendingReward - rewardFee;
        if (expectedDFIDTokenBalanceChange > BigInt(0)) {
            expect(newDFIDToken.balances[userAddress] - previousDFIDToken.balances[userAddress]).to.equal(expectedDFIDTokenBalanceChange, "User's DFIDToken balance should increase by the reward amount");

            if (fee > BigInt(0)) {
                const expectedFeeBalance = rewardFee;
                expect(newDFIDToken.balances[frontendAddress] - previousDFIDToken.balances[frontendAddress]).to.equal(expectedFeeBalance, "Frontend's DFIDToken balance should increase by the reward fee amount");
            }
        }

        const expectedETHBalanceChange = pendingCollateral - collateralFee;
        if (expectedETHBalanceChange > BigInt(0)) {
            expect(newETHBalance - previousETHBalance).to.equal(expectedETHBalanceChange, "User's ETH balance should increase by the collateral amount");

            if (fee > BigInt(0)) {
                // Assuming frontendAddress exists and has an ETH balance
                const previousFrontendETHBalance = previousAccountSnapshot[frontendAddress] || BigInt(0);
                const expectedFrontendETHBalanceChange = collateralFee;
                //expect((newAccountSnapshot[frontendAddress] || BigInt(0)) - previousFrontendETHBalance).to.equal(expectedFrontendETHBalanceChange, "Frontend's ETH balance should increase by the collateral fee amount");
            }
        }

        const expectedSBRBalanceChange = pendingSbrRewards - sbrFee;
        if (expectedSBRBalanceChange > BigInt(0)) {
            expect(newDFIREToken.balances[userAddress] - previousDFIREToken.balances[userAddress]).to.equal(expectedSBRBalanceChange, "User's DFIREToken balance should increase by the SBR reward amount");

            if (fee > BigInt(0)) {
                 const expectedFeeBalance = sbrFee;
                expect(newDFIREToken.balances[frontendAddress] - previousDFIREToken.balances[frontendAddress]).to.equal(expectedFeeBalance, "Frontend's DFIREToken balance should increase by the SBR reward fee amount");
            }
        }

        // Validate user stake update
        if (previousUserInfo && previousUserInfo.cumulativeProductScalingFactor !== BigInt(0)) {
            let expectedStake: bigint;

            if (previousUserInfo.stakeResetCount == newStabilityPool.stakeResetCount) {
                expectedStake = (((previousUserInfo.stake * newStabilityPool.stakeScalingFactor) * newStabilityPool.precision) /
                    previousUserInfo.cumulativeProductScalingFactor) / newStabilityPool.precision;
            } else {
                const snapshot = newStabilityPool.stakeResetSnapshots[previousUserInfo.stakeResetCount];
                expectedStake = ((previousUserInfo.stake * snapshot.scalingFactor * newStabilityPool.precision) /
                    previousUserInfo.cumulativeProductScalingFactor) / newStabilityPool.precision;

                if (previousUserInfo.stakeResetCount + 1 != newStabilityPool.stakeResetCount) {
                    const snapshot2 = newStabilityPool.stakeResetSnapshots[previousUserInfo.stakeResetCount + 1];
                    expectedStake = (expectedStake * snapshot2.scalingFactor) / newStabilityPool.precision;
                } else {
                    expectedStake = (expectedStake * newStabilityPool.stakeScalingFactor) / newStabilityPool.precision;
                }
            }

            expect(newUserInfo.stake).to.equal(expectedStake, "User's stake should be updated correctly based on scaling factors");
        }

    return true;
  }
}
