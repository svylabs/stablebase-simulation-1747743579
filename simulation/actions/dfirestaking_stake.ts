import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { expect } from 'chai';
import { ethers } from 'ethers';

export class StakeAction extends Action {
  private contract: any;

  constructor(contract: any) {
    super('StakeAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const dfireTokenAddress = (context.contracts.dfireToken as any).target;
    const stakingTokenSnapshot = currentSnapshot.contractSnapshot.dfireToken;
    const actorAddress = actor.account.address;

    const actorBalance = stakingTokenSnapshot.balances[actorAddress] || BigInt(0);

    if (actorBalance === BigInt(0)) {
      return [[BigInt(0)], {}];
    }
    const amountToStake = BigInt(Math.floor(context.prng.next() % Number(actorBalance)) + 1n);

    return [[amountToStake], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const amountToStake = actionParams[0];

    if (amountToStake === BigInt(0)) {
      return;
    }

    const dfireTokenAddress = (context.contracts.dfireToken as any).target;
    const contractAddress = this.contract.target;

    // Check allowance and approve if needed
    const stakingTokenSnapshot = currentSnapshot.contractSnapshot.dfireToken;
    const actorAddress = actor.account.address;
    const allowance = stakingTokenSnapshot.allowances[actorAddress] || BigInt(0);

    if (allowance < amountToStake) {
      const dfireTokenContract = new ethers.Contract(
          dfireTokenAddress,
          ["function approve(address spender, uint256 amount) external returns (bool)"],
          actor.account.value as ethers.Signer
      );
      const approveTx = await dfireTokenContract.approve(contractAddress, amountToStake);
      await approveTx.wait();
    }

    const tx = await this.contract.connect(actor.account.value as ethers.Signer).stake(amountToStake);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const amountToStake = actionParams[0];

    if (amountToStake === BigInt(0)) {
      return true;
    }

    const actorAddress = actor.account.address;

    // Validate DFIREStaking state updates
    const previousStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

    const previousStake = previousStakingSnapshot.stakesMapping[actorAddress]?.stake || BigInt(0);
    const newStake = newStakingSnapshot.stakesMapping[actorAddress]?.stake || BigInt(0);
    expect(newStake).to.equal(previousStake + amountToStake, "User's stake should be increased by the staked amount");

    const previousTotalStake = previousStakingSnapshot.totalStake;
    const newTotalStake = newStakingSnapshot.totalStake;
    expect(newTotalStake).to.equal(previousTotalStake + amountToStake, "Contract's total stake should be increased by the staked amount");

    expect(newStakingSnapshot.stakesMapping[actorAddress]?.rewardSnapshot).to.equal(newStakingSnapshot.totalRewardPerToken, "Reward snapshot should be updated");
    expect(newStakingSnapshot.stakesMapping[actorAddress]?.collateralSnapshot).to.equal(newStakingSnapshot.totalCollateralPerToken, "Collateral snapshot should be updated");

    // Validate DFIREToken (staking token) balance updates
    const previousDfireTokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
    const newDfireTokenSnapshot = newSnapshot.contractSnapshot.dfireToken;
    const contractAddress = this.contract.target;

    const previousUserDfireBalance = previousDfireTokenSnapshot.balances[actorAddress] || BigInt(0);
    const newUserDfireBalance = newDfireTokenSnapshot.balances[actorAddress] || BigInt(0);
    expect(newUserDfireBalance).to.equal(previousUserDfireBalance - amountToStake, "User's DFIRE balance should decrease by the staked amount");

    const previousContractDfireBalance = previousDfireTokenSnapshot.balances[contractAddress] || BigInt(0);
    const newContractDfireBalance = newDfireTokenSnapshot.balances[contractAddress] || BigInt(0);
    expect(newContractDfireBalance).to.equal(previousContractDfireBalance + amountToStake, "Contract's DFIRE balance should increase by the staked amount");

    return true;
  }
}
