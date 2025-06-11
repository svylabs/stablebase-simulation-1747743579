import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class StakeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("StakeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
    const actorBalance = dfidTokenSnapshot.balances[actor.account.address] || BigInt(0);

    if (actorBalance <= BigInt(0)) {
      return [false, {}, {}];
    }

    const _amount = BigInt(Math.floor(context.prng.next() % Number(actorBalance))) + BigInt(1); // Ensure _amount > 0
    const frontend = ethers.ZeroAddress;
    const basisPointsDivisor = currentSnapshot.contractSnapshot.stabilityPool.basisPointsDivisor;
    const fee = BigInt(Math.floor(context.prng.next() % Number(basisPointsDivisor)));

    const actionParams = {
      _amount,
      frontend,
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
    const { _amount, frontend, fee } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .stake(_amount, frontend, fee);

    const receipt = await tx.wait();
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
    const { _amount, frontend, fee } = actionParams;
    const actorAddress = actor.account.address;
    const stabilityPoolAddress = this.contract.target;
    const precision = previousSnapshot.contractSnapshot.stabilityPool.precision;
    const stakeScalingFactor = previousSnapshot.contractSnapshot.stabilityPool.stakeScalingFactor;

    // Previous Snapshots
    const prevDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const prevStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const prevActorDfidBalance = prevDfidTokenSnapshot.balances[actorAddress] || BigInt(0);
    const prevStabilityPoolDfidBalance = prevDfidTokenSnapshot.balances[stabilityPoolAddress] || BigInt(0);
    const prevUserStake = prevStabilityPoolSnapshot.users[actorAddress]?.stake || BigInt(0);
    const prevTotalStakedRaw = prevStabilityPoolSnapshot.totalStakedRaw || BigInt(0);
    const prevUserRewardSnapshot = prevStabilityPoolSnapshot.users[actorAddress]?.rewardSnapshot || BigInt(0);
    const prevUserCollateralSnapshot = prevStabilityPoolSnapshot.users[actorAddress]?.collateralSnapshot || BigInt(0);
    const prevTotalRewardPerToken = prevStabilityPoolSnapshot.totalRewardPerToken || BigInt(0);
    const prevTotalCollateralPerToken = prevStabilityPoolSnapshot.totalCollateralPerToken || BigInt(0);
    const prevUserCumulativeProductScalingFactor = prevStabilityPoolSnapshot.users[actorAddress]?.cumulativeProductScalingFactor || BigInt(0);
    const prevUserStakeResetCount = prevStabilityPoolSnapshot.users[actorAddress]?.stakeResetCount || BigInt(0);
    const prevTotalSbrRewardPerToken = prevStabilityPoolSnapshot.totalSbrRewardPerToken || BigInt(0);
    const prevSbrRewardSnapshot = prevStabilityPoolSnapshot.sbrRewardSnapshots[actorAddress]?.rewardSnapshot || BigInt(0);

    // New Snapshots
    const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
    const newActorDfidBalance = newDfidTokenSnapshot.balances[actorAddress] || BigInt(0);
    const newStabilityPoolDfidBalance = newDfidTokenSnapshot.balances[stabilityPoolAddress] || BigInt(0);
    const newUserStake = newStabilityPoolSnapshot.users[actorAddress]?.stake || BigInt(0);
    const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw || BigInt(0);
    const newUserRewardSnapshot = newStabilityPoolSnapshot.users[actorAddress]?.rewardSnapshot || BigInt(0);
    const newUserCollateralSnapshot = newStabilityPoolSnapshot.users[actorAddress]?.collateralSnapshot || BigInt(0);
    const newTotalRewardPerToken = newStabilityPoolSnapshot.totalRewardPerToken || BigInt(0);
    const newTotalCollateralPerToken = newStabilityPoolSnapshot.totalCollateralPerToken || BigInt(0);
    const newUserCumulativeProductScalingFactor = newStabilityPoolSnapshot.users[actorAddress]?.cumulativeProductScalingFactor || BigInt(0);
    const newUserStakeResetCount = newStabilityPoolSnapshot.users[actorAddress]?.stakeResetCount || BigInt(0);
    const newTotalSbrRewardPerToken = newStabilityPoolSnapshot.totalSbrRewardPerToken || BigInt(0);
    const newSbrRewardSnapshot = newStabilityPoolSnapshot.sbrRewardSnapshots[actorAddress]?.rewardSnapshot || BigInt(0);

    // Calculate expected effective stake
    let expectedEffectiveStake = BigInt(0);
    if (prevUserCumulativeProductScalingFactor !== BigInt(0)) {
      expectedEffectiveStake = (((prevUserStake * stakeScalingFactor) * precision) / prevUserCumulativeProductScalingFactor) / precision;
    } else {
      expectedEffectiveStake = prevUserStake;
    }
    expectedEffectiveStake += _amount;

    // Assertions
    expect(newActorDfidBalance, "Actor's staking token balance should decrease by the staked amount.").to.equal(prevActorDfidBalance - _amount);
    expect(newStabilityPoolDfidBalance, "Contract's staking token balance should increase by the staked amount.").to.equal(prevStabilityPoolDfidBalance + _amount);
    expect(newUserStake, "User's stake should be increased by the staked amount, accounting for scaling factors if stake reset occurred.").to.equal(expectedEffectiveStake);
    expect(newTotalStakedRaw, "The total staked amount should be increased by the staked amount.").to.equal(prevTotalStakedRaw + _amount);
    expect(newUserRewardSnapshot, "The user's reward snapshot should be equal to totalRewardPerToken.").to.equal(newTotalRewardPerToken);
    expect(newUserCollateralSnapshot, "The user's collateral snapshot should be equal to totalCollateralPerToken.").to.equal(newTotalCollateralPerToken);
    expect(newUserCumulativeProductScalingFactor, "The user's cumulative product scaling factor should be updated").to.equal(stakeScalingFactor);
    expect(newUserStakeResetCount, "The user's stake reset count should be updated").to.equal(prevStabilityPoolSnapshot.stakeResetCount);
    //Add SBR Reward checks
    expect(newTotalSbrRewardPerToken, "The total SBR reward per token should be greater than or equal to the previous value").to.be.gte(prevTotalSbrRewardPerToken)
    expect(newSbrRewardSnapshot, "The user's SBR reward snapshot should be updated to the current total SBR reward per token").to.be.equal(newTotalSbrRewardPerToken)

    // Check for emitted Staked event
    const stakedEvent = executionReceipt.logs.find(
      (log: any) =>
        log.address === stabilityPoolAddress &&
        log.topics[0] === ethers.keccak256(ethers.toUtf8Bytes("Staked(address,uint256)"))
    );

    expect(stakedEvent, "Staked event should be emitted").to.not.be.undefined;

    return true;
  }
}
