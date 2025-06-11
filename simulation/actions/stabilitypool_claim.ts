import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

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
    const user = stabilityPoolSnapshot.users[actor.account.address];

    if (!user || user.stake <= BigInt(0)) {
      return [false, {}, {}];
    }

    // No parameters to initialize for claim()
    return [true, [], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
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
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
    const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
    const dfireTokenAddress = (context.contracts.dfireToken as ethers.Contract).target;

    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const previousDFIRETokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
    const newDFIRETokenSnapshot = newSnapshot.contractSnapshot.dfireToken;

    const previousUserAccountSnapshot = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newUserAccountSnapshot = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    const previousUser = previousStabilityPoolSnapshot.users[actor.account.address];
    const newUser = newStabilityPoolSnapshot.users[actor.account.address];

    const previousSbrRewardSnapshot = previousStabilityPoolSnapshot.sbrRewardSnapshots[actor.account.address];
    const newSbrRewardSnapshot = newStabilityPoolSnapshot.sbrRewardSnapshots[actor.account.address];

    // User Balances
    const previousPendingRewardAndCollateral = previousStabilityPoolSnapshot.userPendingRewardAndCollateral[actor.account.address] || [BigInt(0), BigInt(0), BigInt(0)];
    const pendingReward = previousPendingRewardAndCollateral[0];
    const pendingCollateral = previousPendingRewardAndCollateral[1];
    const pendingSbrRewards = previousPendingRewardAndCollateral[2];

    let rewardFee = BigInt(0);
    if (pendingReward > BigInt(0)) {
      rewardFee = (pendingReward * BigInt(0)) / previousStabilityPoolSnapshot.basisPointsDivisor; //fee is 0 for simplicity
    }

    let collateralFee = BigInt(0);
    if (pendingCollateral > BigInt(0)) {
      collateralFee = (pendingCollateral * BigInt(0)) / previousStabilityPoolSnapshot.basisPointsDivisor; //fee is 0 for simplicity
    }

    let sbrFee = BigInt(0);
    if (pendingSbrRewards > BigInt(0)) {
      sbrFee = (pendingSbrRewards * BigInt(0)) / previousStabilityPoolSnapshot.basisPointsDivisor; //fee is 0 for simplicity
    }

    const expectedDFIDTokenBalanceChange = pendingReward - rewardFee;
    const expectedETHBalanceChange = pendingCollateral - collateralFee;
    const expectedDFIRETokenBalanceChange = pendingSbrRewards - sbrFee;

    expect(
      (newDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0)) - (previousDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0))
    ).to.equal(expectedDFIDTokenBalanceChange, "User's staking token balance should increase by the pending reward amount, minus the frontend fee.");
    expect(newUserAccountSnapshot - previousUserAccountSnapshot).to.equal(
      expectedETHBalanceChange, "User's ETH balance should increase by the pending collateral amount, minus the frontend fee.");
    expect(
      (newDFIRETokenSnapshot.tokenBalances[actor.account.address] || BigInt(0)) - (previousDFIRETokenSnapshot.tokenBalances[actor.account.address] || BigInt(0))
    ).to.equal(expectedDFIRETokenBalanceChange, "User's SBR token balance should increase by the pending SBR reward amount, minus the frontend fee.");

    if (previousUser && newUser) {
      const stakeScalingFactor = newStabilityPoolSnapshot.stakeScalingFactor;
      const precision = previousStabilityPoolSnapshot.precision;
      const cumulativeProductScalingFactor = previousUser.cumulativeProductScalingFactor;
      const expectedStake = (((previousUser.stake * stakeScalingFactor) * precision) / cumulativeProductScalingFactor) / precision;
      expect(newUser.stake).to.equal(expectedStake, "User's stake should be updated to reflect current stake scaling factor.");
    }

    // Contract State
    const expectedStabilityPoolDFIDTokenBalanceChange = -expectedDFIDTokenBalanceChange;
    const expectedStabilityPoolETHBalanceChange = -expectedETHBalanceChange;

    expect(
      ((newDFIDTokenSnapshot.balances[(context.contracts.stabilityPool as ethers.Contract).target] || BigInt(0)) - (previousDFIDTokenSnapshot.balances[(context.contracts.stabilityPool as ethers.Contract).target] || BigInt(0)))
    ).to.equal(expectedStabilityPoolDFIDTokenBalanceChange, "stakingToken's balance in StabilityPool should decrease by the amount of rewards claimed (minus fees).");
    expect(
      (newSnapshot.accountSnapshot[(context.contracts.stabilityPool as ethers.Contract).target] || BigInt(0)) - (previousSnapshot.accountSnapshot[(context.contracts.stabilityPool as ethers.Contract).target] || BigInt(0))
    ).to.equal(expectedStabilityPoolETHBalanceChange, "StabilityPool's ETH balance should decrease by the amount of collateral claimed (minus fees).");

    if (newUser && previousUser) {
      expect(newUser.rewardSnapshot).to.equal(
        newStabilityPoolSnapshot.totalRewardPerToken, 'Verify that `users[msg.sender].rewardSnapshot` equals `totalRewardPerToken`.'
      );
      expect(newUser.collateralSnapshot).to.equal(
        newStabilityPoolSnapshot.totalCollateralPerToken, 'Verify that `users[msg.sender].collateralSnapshot` equals `totalCollateralPerToken`.'
      );
    }

    // Validate sbrRewardDistributionStatus change
    if (previousStabilityPoolSnapshot.sbrRewardDistributionStatus !== newStabilityPoolSnapshot.sbrRewardDistributionStatus) {
      if (newStabilityPoolSnapshot.sbrRewardDistributionStatus === 2) {
        expect(newStabilityPoolSnapshot.sbrRewardDistributionStatus).to.equal(2, 'sbrRewardDistributionStatus should be ENDED.');
      } else if (newStabilityPoolSnapshot.sbrRewardDistributionStatus === 1 && previousStabilityPoolSnapshot.sbrRewardDistributionStatus === 0) {
        //Started from Not Started
        expect(newStabilityPoolSnapshot.lastSBRRewardDistributedTime).to.equal(executionReceipt.receipt.blockNumber, "lastSBRRewardDistributedTime should be updated to the current block timestamp.");
      }
    }

    if (previousStabilityPoolSnapshot.sbrRewardDistributionStatus !== 2) {
      expect(newSbrRewardSnapshot.rewardSnapshot).to.equal(
        newStabilityPoolSnapshot.totalSbrRewardPerToken, 'Verify that `sbrRewardSnapshots[msg.sender].rewardSnapshot` equals `totalSbrRewardPerToken`.'
      );
    } else if (previousSbrRewardSnapshot && previousSbrRewardSnapshot.status !== 2) {
      expect(newSbrRewardSnapshot.status).to.equal(2, 'Verify that `sbrRewardSnapshots[msg.sender].status` equals `CLAIMED`.');
    }

    // Event Emission
    const rewardClaimedEvent = executionReceipt.receipt.logs.find(
      (log) =>
        log.address === (context.contracts.stabilityPool as ethers.Contract).target &&
        log.topics[0] === ethers.id("RewardClaimed(address,uint256,uint256,uint256,uint256)")
    );

    expect(rewardClaimedEvent).to.not.be.undefined;
    const rewardClaimedEventValues = ethers. AbiCoder.defaultAbiCoder().decode( [ "address", "uint256", "uint256", "uint256", "uint256" ], ethers.getBytes(rewardClaimedEvent.data)) 
    expect(rewardClaimedEventValues[0]).to.equal(actor.account.address, "RewardClaimed event should have correct user address");

    if (pendingSbrRewards > 0) {
      const dFireRewardClaimedEvent = executionReceipt.receipt.logs.find(
        (log) =>
          log.address === (context.contracts.stabilityPool as ethers.Contract).target &&
          log.topics[0] === ethers.id("DFireRewardClaimed(address,uint256,uint256)")
      );
      expect(dFireRewardClaimedEvent).to.not.be.undefined;
          const dFireRewardClaimedEventValues = ethers. AbiCoder.defaultAbiCoder().decode( [ "address", "uint256", "uint256" ], ethers.getBytes(dFireRewardClaimedEvent.data));
          expect(dFireRewardClaimedEventValues[0]).to.equal(actor.account.address, "DFireRewardClaimed event should have correct user address");
    }

    if (newStabilityPoolSnapshot.lastSBRRewardDistributedTime > previousStabilityPoolSnapshot.lastSBRRewardDistributedTime) {
      const sBRRewardsAddedEvent = executionReceipt.receipt.logs.find(
        (log) =>
          log.address === (context.contracts.stabilityPool as ethers.Contract).target &&
          log.topics[0] === ethers.id("SBRRewardsAdded(uint256,uint256,uint256,uint256)")
      );
      expect(sBRRewardsAddedEvent).to.not.be.undefined;
    }

    return true;
  }
}
