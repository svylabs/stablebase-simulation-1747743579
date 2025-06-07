import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

export class UnstakeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('UnstakeAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const stakeByUser = currentSnapshot.contractSnapshot.dfireStaking.stakes?.[actor.account.address] || { stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0) };
    const maxUnstakeAmount = stakeByUser.stake; // Use existing stake as max

    if (maxUnstakeAmount === BigInt(0)) {
      throw new Error("Cannot unstake because user has no stake");
    }

    const amountToUnstake = BigInt(Math.floor(context.prng.next() % Number(maxUnstakeAmount) + 1)); // unstake amount is greater than 0

    const params = [amountToUnstake];
    return [params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const amountToUnstake = actionParams[0];
    const tx = await this.contract.connect(actor.account.value).unstake(amountToUnstake);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const amountToUnstake = actionParams[0];

    const previousStakingState = previousSnapshot.contractSnapshot.dfireStaking;
    const newStakingState = newSnapshot.contractSnapshot.dfireStaking;

    const previousUserStake = previousStakingState.stakes?.[actor.account.address]?.stake || BigInt(0);
    const newUserStake = newStakingState.stakes?.[actor.account.address]?.stake || BigInt(0);

    const previousTotalStake = previousStakingState.totalStake || BigInt(0);
    const newTotalStake = newStakingState.totalStake || BigInt(0);

    const previousRewardSnapshot = previousStakingState.stakes?.[actor.account.address]?.rewardSnapshot || BigInt(0);
    const newRewardSnapshot = newStakingState.stakes?.[actor.account.address]?.rewardSnapshot || BigInt(0);

    const previousCollateralSnapshot = previousStakingState.stakes?.[actor.account.address]?.collateralSnapshot || BigInt(0);
    const newCollateralSnapshot = newStakingState.stakes?.[actor.account.address]?.collateralSnapshot || BigInt(0);

    const previousDFIREBalance = previousSnapshot.contractSnapshot.dfireToken.Balance?.[actor.account.address] || BigInt(0);
    const newDFIREBalance = newSnapshot.contractSnapshot.dfireToken.Balance?.[actor.account.address] || BigInt(0);

    const previousDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.Balance?.[actor.account.address] || BigInt(0);
    const newDFIDBalance = newSnapshot.contractSnapshot.dfidToken.Balance?.[actor.account.address] || BigInt(0);

    // Stake Management
    expect(newUserStake, 'User stake should decrease by the unstaked amount').to.equal(previousUserStake - amountToUnstake);
    expect(newTotalStake, 'Total stake should decrease by the unstaked amount').to.equal(previousTotalStake - amountToUnstake);

    // Reward Distribution
    expect(newRewardSnapshot, "User's rewardSnapshot is updated to totalRewardPerToken").to.equal(newStakingState.totalRewardPerToken);
    expect(newCollateralSnapshot, "User's collateralSnapshot is updated to totalCollateralPerToken").to.equal(newStakingState.totalCollateralPerToken);

    //Token Transfer - DFIRE Token
    expect(newDFIREBalance, "User's DFIRE balance increases by _amount").to.equal(previousDFIREBalance + amountToUnstake);

    // Account ETH balance should remain the same (gas costs are negligible for validation)
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    expect(newAccountBalance).to.be.gte(previousAccountBalance);

    //Reward Token Transfer - DFID Token
    const reward = ((previousStakingState.totalRewardPerToken - previousRewardSnapshot) * previousUserStake) / BigInt(10**18) 
    const collateralReward = ((previousStakingState.totalCollateralPerToken - previousCollateralSnapshot) * previousUserStake) / BigInt(10**18)

    if (reward > 0n) {
        expect(newDFIDBalance).to.equal(previousDFIDBalance + reward, "User's DFID balance should increase by reward amount");
    }

     return true;
  }
}
