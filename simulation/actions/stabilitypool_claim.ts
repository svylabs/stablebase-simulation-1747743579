import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";

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
    // No parameters for the claim function
    return [[], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    try {
      const tx = await this.contract.connect(actor.account.value).claim();
      await tx.wait();
    } catch (e) {
      console.error(e);
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool;
    const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool;
    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;
    const dfireTokenPrevious = previousSnapshot.contractSnapshot.dfireToken;
    const dfireTokenNew = newSnapshot.contractSnapshot.dfireToken;

    const userAddress = actor.account.address;
    const frontend = ethers.ZeroAddress;
    const fee = BigInt(0);

    // Fetch previous and new user info from StabilityPool snapshots
    const previousUserInfo = stabilityPoolPrevious?.users[userAddress] || {
      stake: BigInt(0),
      rewardSnapshot: BigInt(0),
      collateralSnapshot: BigInt(0),
      cumulativeProductScalingFactor: BigInt(0),
      stakeResetCount: BigInt(0),
    };
    const newUserInfo = stabilityPoolNew?.users[userAddress] || {
      stake: BigInt(0),
      rewardSnapshot: BigInt(0),
      collateralSnapshot: BigInt(0),
      cumulativeProductScalingFactor: BigInt(0),
      stakeResetCount: BigInt(0),
    };

    // Calculate pending rewards, collateral, and SBR rewards using the snapshots and contract code
    async function userPendingRewardAndCollateral(
      user: any,
      totalRewardPerToken: bigint,
      totalCollateralPerToken: bigint,
      totalSbrRewardPerToken: bigint,
      sbrRewardSnapshots: any,
      stakeResetSnapshots: any,
      stakeResetCount: bigint
    ): Promise<[bigint, bigint, bigint]> {
      let pendingReward = BigInt(0);
      let pendingCollateral = BigInt(0);
      let pendingSbrRewards = BigInt(0);
      let calculateSbrRewards = true;

      if (sbrRewardSnapshots[userAddress]?.status === 2) {
        calculateSbrRewards = false;
      }

      if (user.stakeResetCount === stakeResetCount) {
        pendingReward = (((totalRewardPerToken - user.rewardSnapshot) * user.stake * stabilityPoolNew.precision) / user.cumulativeProductScalingFactor) / stabilityPoolNew.precision;
        pendingCollateral = (((totalCollateralPerToken - user.collateralSnapshot) * user.stake * stabilityPoolNew.precision) / user.cumulativeProductScalingFactor) / stabilityPoolNew.precision;

        if (calculateSbrRewards) {
          pendingSbrRewards = (((totalSbrRewardPerToken - (sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0))) * user.stake * stabilityPoolNew.precision) / user.cumulativeProductScalingFactor) / stabilityPoolNew.precision;
        }
      } else {
        const snapshot = stakeResetSnapshots[Number(user.stakeResetCount)];
        if (!snapshot) {
          return [BigInt(0), BigInt(0), BigInt(0)];
        }
        pendingReward = (((snapshot.totalRewardPerToken - user.rewardSnapshot) * user.stake * stabilityPoolNew.precision) / user.cumulativeProductScalingFactor) / stabilityPoolNew.precision;
        pendingCollateral = (((snapshot.totalCollateralPerToken - user.collateralSnapshot) * user.stake * stabilityPoolNew.precision) / user.cumulativeProductScalingFactor) / stabilityPoolNew.precision;

        if (calculateSbrRewards) {
          pendingSbrRewards = (((snapshot.totalSBRRewardPerToken - (sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0))) * user.stake * stabilityPoolNew.precision) / user.cumulativeProductScalingFactor) / stabilityPoolNew.precision;
        }

        const userStake = ((user.stake * snapshot.scalingFactor * stabilityPoolNew.precision) / user.cumulativeProductScalingFactor) / stabilityPoolNew.precision;

        if (user.stakeResetCount + BigInt(1) !== stabilityPoolNew.stakeResetCount) {
          const snapshot2 = stakeResetSnapshots[Number(user.stakeResetCount + BigInt(1))];
          if (!snapshot2) {
            return [BigInt(0), BigInt(0), BigInt(0)];
          }
          pendingReward += (snapshot2.totalRewardPerToken * userStake) / stabilityPoolNew.precision;
          pendingCollateral += (snapshot2.totalCollateralPerToken * userStake) / stabilityPoolNew.precision;

          if (calculateSbrRewards) {
            pendingSbrRewards += (snapshot2.totalSBRRewardPerToken * userStake) / stabilityPoolNew.precision;
          }
        } else {
          pendingReward += (stabilityPoolNew.totalRewardPerToken * userStake) / stabilityPoolNew.precision;
          pendingCollateral += (stabilityPoolNew.totalCollateralPerToken * userStake) / stabilityPoolNew.precision;

          if (calculateSbrRewards) {
            pendingSbrRewards += (stabilityPoolNew.totalSbrRewardPerToken * userStake) / stabilityPoolNew.precision;
          }
        }
      }

      return [pendingReward, pendingCollateral, pendingSbrRewards];
    }

    const [pendingRewardPrevious, pendingCollateralPrevious, pendingSbrRewardsPrevious] = await userPendingRewardAndCollateral(
      previousUserInfo,
      stabilityPoolPrevious?.totalRewardPerToken || BigInt(0),
      stabilityPoolPrevious?.totalCollateralPerToken || BigInt(0),
      stabilityPoolPrevious?.totalSbrRewardPerToken || BigInt(0),
      stabilityPoolPrevious?.sbrRewardSnapshots || {},
      stabilityPoolPrevious?.stakeResetSnapshots || {},
      stabilityPoolPrevious?.stakeResetCount || BigInt(0)
    );
    const [pendingRewardNew, pendingCollateralNew, pendingSbrRewardsNew] = await userPendingRewardAndCollateral(
      previousUserInfo,
      stabilityPoolNew?.totalRewardPerToken || BigInt(0),
      stabilityPoolNew?.totalCollateralPerToken || BigInt(0),
      stabilityPoolNew?.totalSbrRewardPerToken || BigInt(0),
      stabilityPoolNew?.sbrRewardSnapshots || {},
      stabilityPoolNew?.stakeResetSnapshots || {},
      stabilityPoolNew?.stakeResetCount || BigInt(0)
    );

    const rewardFee = (fee * pendingRewardPrevious) / BigInt(10000);
    const collateralFee = (fee * pendingCollateralPrevious) / BigInt(10000);
    const sbrFee = (fee * pendingSbrRewardsPrevious) / BigInt(10000);

    // // User Info Validations
    expect(newUserInfo.rewardSnapshot).to.equal(stabilityPoolNew.totalRewardPerToken, "user.rewardSnapshot should be equal to totalRewardPerToken after claim");
    expect(newUserInfo.collateralSnapshot).to.equal(stabilityPoolNew.totalCollateralPerToken, "user.collateralSnapshot should be equal to totalCollateralPerToken after claim");
    expect(newUserInfo.cumulativeProductScalingFactor).to.equal(stabilityPoolNew.stakeScalingFactor, "user.cumulativeProductScalingFactor should be equal to stakeScalingFactor after claim");
    expect(newUserInfo.stakeResetCount).to.equal(stabilityPoolNew.stakeResetCount, "user.stakeResetCount should be equal to stakeResetCount after claim");

    // Reward Balance Validations
    const expectedDFIDTokenBalanceUser = (dfidTokenPrevious?.Balance[userAddress] || BigInt(0)) + (pendingRewardPrevious - rewardFee);
    if (pendingRewardPrevious > BigInt(0)) {
      expect(dfidTokenNew?.Balance[userAddress] || BigInt(0)).to.equal(expectedDFIDTokenBalanceUser, "User's DFIDToken balance should increase by (pendingReward - rewardFee)");
    }
    if (rewardFee > BigInt(0)) {
      const expectedDFIDTokenBalanceFrontend = (dfidTokenPrevious?.Balance[frontend] || BigInt(0)) + rewardFee;
      expect(dfidTokenNew?.Balance[frontend] || BigInt(0)).to.equal(expectedDFIDTokenBalanceFrontend, "Frontend's DFIDToken balance should increase by rewardFee");
    }

    const expectedETHBalanceUser = (previousSnapshot.accountSnapshot[userAddress] || BigInt(0)) + (pendingCollateralPrevious - collateralFee);
    if (pendingCollateralPrevious > BigInt(0)) {
      expect(newSnapshot.accountSnapshot[userAddress] || BigInt(0)).to.equal(expectedETHBalanceUser, "User's ETH balance should increase by (pendingCollateral - collateralFee)");
    }

    const expectedDFIRETokenBalanceUser = (dfireTokenPrevious?.Balance || BigInt(0)) + (pendingSbrRewardsPrevious - sbrFee);
    if (pendingSbrRewardsPrevious > BigInt(0)) {
      expect(dfireTokenNew?.Balance || BigInt(0)).to.equal(expectedDFIRETokenBalanceUser, "User's DFIREToken balance should increase by (pendingSbrRewards - sbrFee)");
    }

    // SBR Rewards Validations
    if (stabilityPoolNew?.sbrRewardDistributionStatus !== 2) {
      expect(stabilityPoolNew?.sbrRewardSnapshots[userAddress]?.rewardSnapshot).to.equal(stabilityPoolNew.totalSbrRewardPerToken, "sbrRewardSnapshots[msg.sender].rewardSnapshot should be equal to totalSbrRewardPerToken");
    } else if (stabilityPoolPrevious?.sbrRewardSnapshots[userAddress]?.status !== 2) {
      expect(stabilityPoolNew?.sbrRewardSnapshots[userAddress]?.status).to.equal(2, "sbrRewardSnapshots[msg.sender].status should be CLAIMED");
    }

    return true;
  }
}
