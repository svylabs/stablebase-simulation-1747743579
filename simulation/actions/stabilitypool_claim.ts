import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

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
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    if (!stabilityPoolSnapshot) {
      console.warn("StabilityPool snapshot not found");
      return [false, {}, {}];
    }

    const user = stabilityPoolSnapshot.users[actor.account.address];
    if (!user || user.stake <= BigInt(0)) {
      console.warn("User stake is zero or user does not exist.");
      return [false, {}, {}];
    }

    // Determine frontend address and fee based on snapshot data (randomly within bounds)
    let frontendAddress = ethers.ZeroAddress;
    let fee = BigInt(0);

    // Example: 50% chance to set a fee and frontend address
    if (context.prng.next() % 2 === 0) {
      // Generate a random fee between 0 and BASIS_POINTS_DIVISOR
      fee = BigInt(context.prng.next()) % stabilityPoolSnapshot.basisPointsDivisor;
      // Generate a random address for frontend (replace with a valid approach if needed)
      frontendAddress = ethers.Wallet.createRandom().address;
    }

    const actionParams = {
      frontendAddress,
      fee,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { frontendAddress, fee } = actionParams;
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
    const { frontendAddress, fee } = actionParams;
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
    const dfidToken = context.contracts.dfidToken as ethers.Contract;
    const dfireToken = context.contracts.dfireToken as ethers.Contract;

    if (!previousStabilityPoolSnapshot || !newStabilityPoolSnapshot) {
      console.warn("StabilityPool snapshot not found");
      return false;
    }

    const previousUser = previousStabilityPoolSnapshot.users[actor.account.address];
    const newUser = newStabilityPoolSnapshot.users[actor.account.address];

    if (!previousUser || !newUser) {
      console.warn("User info not found in snapshots");
      return false;
    }

    const previousSbrRewardSnapshot = previousStabilityPoolSnapshot.sbrRewardSnapshots[actor.account.address];
    const newSbrRewardSnapshot = newStabilityPoolSnapshot.sbrRewardSnapshots[actor.account.address];

    const previousAccountETHBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountETHBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    const previousDFIDTokenBalance = previousSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);
    const newDFIDTokenBalance = newSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);

    const previousDFIRETokenBalance = previousSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);
    const newDFIRETokenBalance = newSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);

    const previousStabilityPoolDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.balances[(this.contract as ethers.Contract).target] || BigInt(0);
    const newStabilityPoolDFIDBalance = newSnapshot.contractSnapshot.dfidToken.balances[(this.contract as ethers.Contract).target] || BigInt(0);

    const previousStabilityPoolETHBalance = previousSnapshot.accountSnapshot[(this.contract as ethers.Contract).target] || BigInt(0);
    const newStabilityPoolETHBalance = newSnapshot.accountSnapshot[(this.contract as ethers.Contract).target] || BigInt(0);

    // Fetch pending amounts and fee
    let pendingReward = BigInt(0);
    let pendingCollateral = BigInt(0);
    let pendingSbrRewards = BigInt(0);

    let calculateSbrRewards = true;
    if (previousSbrRewardSnapshot && previousSbrRewardSnapshot.status === 2) {
      calculateSbrRewards = false;
    }

    if (previousUser.stakeResetCount == newStabilityPoolSnapshot.stakeResetCount) {
      pendingReward = ((((newStabilityPoolSnapshot.totalRewardPerToken - previousUser.rewardSnapshot) * previousUser.stake) * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;
      pendingCollateral = ((((newStabilityPoolSnapshot.totalCollateralPerToken - previousUser.collateralSnapshot) * previousUser.stake) * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;
      if (calculateSbrRewards && previousSbrRewardSnapshot) {
        pendingSbrRewards = ((((newStabilityPoolSnapshot.totalSbrRewardPerToken - previousSbrRewardSnapshot.rewardSnapshot) * previousUser.stake) * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;
      }
    } else {
      let snapshot = previousStabilityPoolSnapshot.stakeResetSnapshots[previousUser.stakeResetCount.toString()];
      if (!snapshot) {
        console.warn("stakeResetSnapshots not found");
        return false;
      }

      pendingReward = ((((snapshot.totalRewardPerToken - previousUser.rewardSnapshot) * previousUser.stake) * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;
      pendingCollateral = ((((snapshot.totalCollateralPerToken - previousUser.collateralSnapshot) * previousUser.stake) * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;

      if (calculateSbrRewards && previousSbrRewardSnapshot) {
        pendingSbrRewards = ((((snapshot.totalSBRRewardPerToken - previousSbrRewardSnapshot.rewardSnapshot) * previousUser.stake) * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;
      }

      let userStake = ((previousUser.stake * snapshot.scalingFactor * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;
      if (previousUser.stakeResetCount + BigInt(1) != newStabilityPoolSnapshot.stakeResetCount) {
        snapshot = previousStabilityPoolSnapshot.stakeResetSnapshots[(previousUser.stakeResetCount + BigInt(1)).toString()];
        if (!snapshot) {
          console.warn("stakeResetSnapshots not found");
          return false;
        }
        pendingReward += (snapshot.totalRewardPerToken * userStake) / newStabilityPoolSnapshot.precision;
        pendingCollateral += (snapshot.totalCollateralPerToken * userStake) / newStabilityPoolSnapshot.precision;
        if (calculateSbrRewards && previousSbrRewardSnapshot) {
          pendingSbrRewards += (snapshot.totalSBRRewardPerToken * userStake) / newStabilityPoolSnapshot.precision;
        }
      } else {
        pendingReward += (newStabilityPoolSnapshot.totalRewardPerToken * userStake) / newStabilityPoolSnapshot.precision;
        pendingCollateral += (newStabilityPoolSnapshot.totalCollateralPerToken * userStake) / newStabilityPoolSnapshot.precision;
        if (calculateSbrRewards && previousSbrRewardSnapshot) {
          pendingSbrRewards += (newStabilityPoolSnapshot.totalSbrRewardPerToken * userStake) / newStabilityPoolSnapshot.precision;
        }
      }
    }

    const rewardFee = (fee * pendingReward) / newStabilityPoolSnapshot.basisPointsDivisor;
    const collateralFee = (fee * pendingCollateral) / newStabilityPoolSnapshot.basisPointsDivisor;
    const sbrFee = (fee * pendingSbrRewards) / newStabilityPoolSnapshot.basisPointsDivisor;


    // Check user balances
    expect(newDFIDTokenBalance - previousDFIDTokenBalance).to.equal(pendingReward - rewardFee, "User staking token balance should increase by pending reward minus fee");
    expect(newAccountETHBalance - previousAccountETHBalance).to.equal(pendingCollateral - collateralFee, "User ETH balance should increase by pending collateral minus fee");
    expect(newDFIRETokenBalance - previousDFIRETokenBalance).to.equal(pendingSbrRewards - sbrFee, "User SBR token balance should increase by pending SBR reward minus fee");

    // Check StabilityPool token balances
    expect(previousStabilityPoolDFIDBalance - newStabilityPoolDFIDBalance).to.equal(pendingReward - rewardFee, "StabilityPool staking token balance should decrease by rewards claimed");
    expect(previousStabilityPoolETHBalance - newStabilityPoolETHBalance).to.equal(pendingCollateral - collateralFee, "StabilityPool ETH balance should decrease by collateral claimed");

    // Check stake updates
    let effectiveStake = BigInt(0);
    if (previousUser.stakeResetCount == newStabilityPoolSnapshot.stakeResetCount) {
      effectiveStake = (previousUser.stake * newStabilityPoolSnapshot.stakeScalingFactor * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor / newStabilityPoolSnapshot.precision;
    } else {
      let snapshot = previousStabilityPoolSnapshot.stakeResetSnapshots[previousUser.stakeResetCount.toString()];
      if (!snapshot) {
        console.warn("stakeResetSnapshots not found");
        return false;
      }
      effectiveStake = ((previousUser.stake * snapshot.scalingFactor * newStabilityPoolSnapshot.precision) / previousUser.cumulativeProductScalingFactor) / newStabilityPoolSnapshot.precision;

      if (previousUser.stakeResetCount + BigInt(1) != newStabilityPoolSnapshot.stakeResetCount) {
        snapshot = previousStabilityPoolSnapshot.stakeResetSnapshots[(previousUser.stakeResetCount + BigInt(1)).toString()];
        if (!snapshot) {
          console.warn("stakeResetSnapshots not found");
          return false;
        }
        effectiveStake = (effectiveStake * snapshot.scalingFactor) / newStabilityPoolSnapshot.precision;
      } else {
        effectiveStake = (effectiveStake * newStabilityPoolSnapshot.stakeScalingFactor) / newStabilityPoolSnapshot.precision;
      }
    }

    expect(newUser.stake).to.equal(effectiveStake, "User stake should be updated to reflect current stake scaling factor");

    expect(newUser.cumulativeProductScalingFactor).to.equal(newStabilityPoolSnapshot.stakeScalingFactor, "User cumulativeProductScalingFactor should be updated to stakeScalingFactor");
    expect(newUser.stakeResetCount).to.equal(newStabilityPoolSnapshot.stakeResetCount, "User stakeResetCount should be updated to stakeResetCount");

    // SBR Reward Distribution Status Validation
    if (newStabilityPoolSnapshot.sbrRewardDistributionStatus != previousStabilityPoolSnapshot.sbrRewardDistributionStatus) {
      if (newStabilityPoolSnapshot.sbrRewardDistributionStatus == 1) {
        // STARTED
        expect(newStabilityPoolSnapshot.sbrRewardDistributionEndTime).to.equal(BigInt(new Date().getTime() / 1000) + BigInt(365 * 24 * 60 * 60), "sbrRewardDistributionEndTime should be updated");
      }
      //expect(newStabilityPoolSnapshot.lastSBRRewardDistributedTime).to.equal(BigInt(Math.floor(Date.now() / 1000)), "lastSBRRewardDistributedTime should be updated");
    }

    if (newStabilityPoolSnapshot.sbrRewardDistributionStatus == 2 && previousSbrRewardSnapshot && previousSbrRewardSnapshot.status != 2) {
      expect(newSbrRewardSnapshot.status).to.equal(2, "User SBR reward status should be CLAIMED");
    }

    // Event Emission Validation
    const rewardClaimedEvent = executionReceipt.receipt.logs.find(
      (log) =>
        log.address === (this.contract as ethers.Contract).target &&
        log.topics[0] === ethers.keccak256(ethers.toUtf8Bytes("RewardClaimed(address,uint256,uint256,uint256,uint256)"))
    );

    if (rewardClaimedEvent) {
      const decodedEvent = this.contract.interface.parseLog(rewardClaimedEvent);
      expect(decodedEvent.args[0]).to.equal(actor.account.address, "RewardClaimed event - user address mismatch");
      expect(decodedEvent.args[1]).to.equal(pendingReward, "RewardClaimed event - reward amount mismatch");
      expect(decodedEvent.args[2]).to.equal(rewardFee, "RewardClaimed event - reward fee mismatch");
      expect(decodedEvent.args[3]).to.equal(pendingCollateral, "RewardClaimed event - collateral amount mismatch");
      expect(decodedEvent.args[4]).to.equal(collateralFee, "RewardClaimed event - collateral fee mismatch");
    }

    const dFireRewardClaimedEvent = executionReceipt.receipt.logs.find(
      (log) =>
        log.address === (this.contract as ethers.Contract).target &&
        log.topics[0] === ethers.keccak256(ethers.toUtf8Bytes("DFireRewardClaimed(address,uint256,uint256)"))
    );

    if (dFireRewardClaimedEvent) {
      const decodedEvent = this.contract.interface.parseLog(dFireRewardClaimedEvent);
      expect(decodedEvent.args[0]).to.equal(actor.account.address, "DFireRewardClaimed event - user address mismatch");
      expect(decodedEvent.args[1]).to.equal(pendingSbrRewards, "DFireRewardClaimed event - sbrReward amount mismatch");
      expect(decodedEvent.args[2]).to.equal(sbrFee, "DFireRewardClaimed event - sbrFee mismatch");
    }

    const sBRRewardsAddedEvent = executionReceipt.receipt.logs.find(
      (log) =>
        log.address === (this.contract as ethers.Contract).target &&
        log.topics[0] === ethers.keccak256(ethers.toUtf8Bytes("SBRRewardsAdded(uint256,uint256,uint256,uint256)"))
    );

    if (sBRRewardsAddedEvent) {
      const decodedEvent = this.contract.interface.parseLog(sBRRewardsAddedEvent);
      //cannot validate all values since `_addSBRRewards` may be called by other actions, values may not be same.
      expect(decodedEvent.name).to.equal("SBRRewardsAdded");
    }

    return true;
  }
}
