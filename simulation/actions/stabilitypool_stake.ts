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
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;

    if (!stabilityPoolSnapshot || !dfidTokenSnapshot) {
      console.warn("StabilityPool or DFIDToken snapshot not available.");
      return [false, {}, {}];
    }

    const actorAddress = actor.account.address;
    const actorBalance = dfidTokenSnapshot.balances[actorAddress] || BigInt(0);

    if (actorBalance <= BigInt(0)) {
      console.warn("Actor has insufficient balance to stake.");
      return [false, {}, {}];
    }

    const _amount = BigInt(context.prng.next()) % actorBalance + BigInt(1); // Ensure amount > 0
    const frontend = ethers.constants.AddressZero; // Or generate a random address if needed
    const fee = BigInt(context.prng.next()) % (stabilityPoolSnapshot.basisPointsDivisor + BigInt(1)); // fee between 0 and BASIS_POINTS_DIVISOR

    const canExecute = _amount > BigInt(0);
    const actionParams = canExecute ? {
      _amount,
      frontend,
      fee
    } : {};

    return [canExecute, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const actorSigner = actor.account.value;
    return this.contract.connect(actorSigner).stake(
      actionParams._amount,
      actionParams.frontend,
      actionParams.fee
    );
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const _amount = actionParams._amount;
    const frontend = actionParams.frontend;
    const fee = actionParams.fee;
    const actorAddress = actor.account.address;
    const stabilityPoolAddress = (context.contracts.stabilityPool as ethers.Contract).target;
    const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
    const stableBaseCDPAddress = (context.contracts.stableBaseCDP as ethers.Contract).target;

    // Get previous and new snapshots
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    // Token balances validation
    const previousActorTokenBalance = previousDFIDTokenSnapshot.balances[actorAddress] || BigInt(0);
    const newActorTokenBalance = newDFIDTokenSnapshot.balances[actorAddress] || BigInt(0);
    const previousContractTokenBalance = previousDFIDTokenSnapshot.balances[stabilityPoolAddress] || BigInt(0);
    const newContractTokenBalance = newDFIDTokenSnapshot.balances[stabilityPoolAddress] || BigInt(0);

    expect(newActorTokenBalance, "Actor's staking token balance should decrease by the staked amount.").to.equal(previousActorTokenBalance - _amount);
    expect(newContractTokenBalance, "Contract's staking token balance should increase by the staked amount.").to.equal(previousContractTokenBalance + _amount);

    // Stake validation
    const previousUserStake = previousStabilityPoolSnapshot.users[actorAddress]?.stake || BigInt(0);
    const newUserStake = newStabilityPoolSnapshot.users[actorAddress]?.stake || BigInt(0);
    const totalStakedRawPrevious = previousStabilityPoolSnapshot.totalStakedRaw || BigInt(0);
    const totalStakedRawNew = newStabilityPoolSnapshot.totalStakedRaw || BigInt(0);

    expect(newUserStake, "User's stake should increase.").to.be.gte(previousUserStake);
    expect(totalStakedRawNew, "Total staked amount should increase by the staked amount.").to.equal(totalStakedRawPrevious + _amount);

    const previousRewardSnapshot = previousStabilityPoolSnapshot.users[actorAddress]?.rewardSnapshot || BigInt(0);
    const newRewardSnapshot = newStabilityPoolSnapshot.users[actorAddress]?.rewardSnapshot || BigInt(0);
    expect(newRewardSnapshot, "User's reward snapshot should be equal to totalRewardPerToken.").to.equal(newStabilityPoolSnapshot.totalRewardPerToken);

    const previousCollateralSnapshot = previousStabilityPoolSnapshot.users[actorAddress]?.collateralSnapshot || BigInt(0);
    const newCollateralSnapshot = newStabilityPoolSnapshot.users[actorAddress]?.collateralSnapshot || BigInt(0);
    expect(newCollateralSnapshot, "User's collateral snapshot should be equal to totalCollateralPerToken.").to.equal(newStabilityPoolSnapshot.totalCollateralPerToken);

    // SBR reward validation (if applicable)
    if (previousStabilityPoolSnapshot.sbrRewardDistributionStatus !== 2) { // Assuming 2 is the enum for ENDED
        if (previousStabilityPoolSnapshot.totalStakedRaw === BigInt(0) && previousStabilityPoolSnapshot.rewardSenderActive) {
            expect(newSnapshot.contractSnapshot.stableBaseCDP.stabilityPoolCanReceiveRewards, "IRewardSender(stableBaseCDP).setCanStabilityPoolReceiveRewards(true) should have been successfully called.").to.be.true;
        }

        if (previousStabilityPoolSnapshot.sbrRewardDistributionStatus === 1) { // Assuming 1 is the enum for STARTED
            expect(newStabilityPoolSnapshot.totalSbrRewardPerToken, "totalSbrRewardPerToken should have increased").to.be.gte(previousStabilityPoolSnapshot.totalSbrRewardPerToken);
        }
    }

    // Event Emission Validation
    const stakedEvent = executionReceipt.events?.find(e => e.name === 'Staked');
    expect(stakedEvent, 'Staked event should be emitted').to.not.be.undefined;
    expect(stakedEvent?.args?.account, 'Staked event should have correct account').to.equal(actorAddress);
    expect(stakedEvent?.args?.amount, 'Staked event should have correct amount').to.equal(_amount);

    // Reward Claimed Event
     const rewardClaimedEvent = executionReceipt.events?.find(e => e.name === 'RewardClaimed');

     // DFire Claimed Event
     const dFireRewardClaimedEvent = executionReceipt.events?.find(e => e.name === 'DFireRewardClaimed');

    return true;
  }
}
