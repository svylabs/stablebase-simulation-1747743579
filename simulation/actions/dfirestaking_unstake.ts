import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class UnstakeAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("UnstakeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const dfireStakingState = currentSnapshot.contractSnapshot.dfireStaking;
    const userStake = dfireStakingState.getStake(actor.account.address).stake;

    if (userStake <= BigInt(0)) {
      return [false, {}, {}];
    }

    const amountToUnstake = context.prng.next() % (Number(userStake) + 1);
    const _amount = BigInt(amountToUnstake);

    if (_amount <= BigInt(0)) {
      return [false, {}, {}];
    }

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
  ): Promise<Record<string, any> | void> {
    const { _amount } = actionParams;
    const tx = await this.contract.connect(actor.account.value).unstake(_amount);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { _amount } = actionParams;

    const previousDfireStakingState = previousSnapshot.contractSnapshot.dfireStaking;
    const newDfireStakingState = newSnapshot.contractSnapshot.dfireStaking;
    const previousDfireTokenState = previousSnapshot.contractSnapshot.dfireToken;
    const newDfireTokenState = newSnapshot.contractSnapshot.dfireToken;
    const previousDFIDTokenState = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenState = newSnapshot.contractSnapshot.dfidToken;

    const previousUserStake = previousDfireStakingState.getStake(actor.account.address);
    const newUserStake = newDfireStakingState.getStake(actor.account.address);

    const previousTotalStake = previousDfireStakingState.totalStake;
    const newTotalStake = newDfireStakingState.totalStake;

    const previousTotalRewardPerToken = previousDfireStakingState.totalRewardPerToken;
    const newTotalRewardPerToken = newDfireStakingState.totalRewardPerToken;

    const previousTotalCollateralPerToken = previousDfireStakingState.totalCollateralPerToken;
    const newTotalCollateralPerToken = newDfireStakingState.totalCollateralPerToken;

    const previousDfireBalance = previousDfireTokenState.balances[actor.account.address] || BigInt(0);
    const newDfireBalance = newDfireTokenState.balances[actor.account.address] || BigInt(0);

    const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newEthBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    // Reward sender status validation
    if (previousDfireStakingState.rewardSenderActive && newTotalStake === BigInt(0)) {
      expect(newDfireStakingState.rewardSenderActive).to.be.false,
        "If rewardSenderActive was true and totalStake is now 0, then rewardSenderActive should be false.";
    }

    //stake validation
    expect(newUserStake.stake).to.equal(previousUserStake.stake - _amount, "User's stake should be decreased by _amount.");
    expect(newTotalStake).to.equal(previousTotalStake - _amount, "totalStake should be decreased by _amount.");
    expect(newUserStake.stake).to.be.at.least(BigInt(0), "stakes[msg.sender].stake should be non-negative.");

    //reward validation
    expect(newUserStake.rewardSnapshot).to.equal(previousTotalRewardPerToken, "stakes[msg.sender].rewardSnapshot should be equal to the contract's totalRewardPerToken at the start of the unstake transaction.");
    expect(newUserStake.collateralSnapshot).to.equal(previousTotalCollateralPerToken, "stakes[msg.sender].collateralSnapshot should be equal to the contract's totalCollateralPerToken at the start of the unstake transaction.");

    //transfer and events
    expect(newDfireBalance).to.equal(previousDfireBalance + _amount, "The user's stakingToken balance should increase by _amount.");

    // Check for Unstaked event
    const unstakedEvent = executionReceipt.events.find(e => e.name === 'Unstaked' && e.args.account === actor.account.address);
    expect(unstakedEvent).to.not.be.undefined;
    expect(unstakedEvent.args.amount).to.equal(_amount, "Unstaked event should have the correct amount");

    // Check for Claimed event
    const claimedEvent = executionReceipt.events.find(e => e.name === 'Claimed' && e.args.account === actor.account.address);
    expect(claimedEvent).to.not.be.undefined;

    //Fetch reward from the event.
    const rewardAmount = claimedEvent?.args?.reward ?? BigInt(0);

    //Fetch collateralReward from the event.
    const collateralReward = claimedEvent?.args?.collateralReward ?? BigInt(0);

    //Validation of reward token balance after unstake
    const prevDFIDTokenBalance = previousDFIDTokenState.balances ? (previousDFIDTokenState.balances[actor.account.address] || BigInt(0)) : BigInt(0);
    const newDFIDTokenBalance = newDFIDTokenState.balances ? (newDFIDTokenState.balances[actor.account.address] || BigInt(0)) : BigInt(0);

    if (rewardAmount > 0) {
      expect(newDFIDTokenBalance).to.equal(prevDFIDTokenBalance + rewardAmount, "The user's rewardToken balance should increase by the reward amount calculated based on their stake and reward snapshots.");
    }
    //Validation of eth balance after unstake
    if (collateralReward > 0) {
      expect(newEthBalance).to.equal(previousEthBalance + collateralReward, "The user's ETH balance should increase by the collateral reward amount.");
    }

    return true;
  }
}
