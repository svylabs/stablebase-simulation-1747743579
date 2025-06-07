import { ethers } from 'ethers';
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { StabilityPoolContractSnapshot, DFIDTokenContractSnapshot, DFIRETokenContractSnapshot, StableBaseCDPContractSnapshot } from '../snapshot_interfaces';

export class StakeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('StakeAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Assuming a maximum stake amount of 1000 for simplicity, adjust as needed based on actual token supply.
    const maxStakeAmount = 1000;
    const amount = BigInt(Math.floor(context.prng.next() % maxStakeAmount) + 1); // Ensure amount > 0
    const frontend = ethers.ZeroAddress;
    const fee = BigInt(Math.floor(context.prng.next() % 10001)); // Ensure fee is between 0 and 10000

    const actionParams = [amount, frontend, fee];
    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [amount, frontend, fee] = actionParams;
    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .stake(amount, frontend, fee);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const [amount, frontend, fee] = actionParams;
    const stabilityPoolAddress = this.contract.target;
    const actorAddress = actor.account.address;

    // Get previous and new contract snapshots
    const previousStabilityPoolSnapshot: StabilityPoolContractSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot: StabilityPoolContractSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    // Get previous and new DFIDToken snapshots
    const previousDFIDTokenSnapshot: DFIDTokenContractSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot: DFIDTokenContractSnapshot = newSnapshot.contractSnapshot.dfidToken;

    // Get previous and new DFIREToken snapshots
    const previousDFIRETokenSnapshot: DFIRETokenContractSnapshot = previousSnapshot.contractSnapshot.dfireToken;
    const newDFIRETokenSnapshot: DFIRETokenContractSnapshot = newSnapshot.contractSnapshot.dfireToken;

    // Get previous and new StableBaseCDP snapshots
    const previousStableBaseCDPSnapshot: StableBaseCDPContractSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot: StableBaseCDPContractSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousActorDFIDBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    const newActorDFIDBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);

    const previousStabilityPoolDFIDBalance = previousSnapshot.accountSnapshot[stabilityPoolAddress] || BigInt(0);
    const newStabilityPoolDFIDBalance = newSnapshot.accountSnapshot[stabilityPoolAddress] || BigInt(0);

    // Validate User Stake
    expect(
      newStabilityPoolSnapshot.stabilityPoolState?.users[actorAddress]?.stake,
      'users[msg.sender].stake should be increased by _amount.'
    ).to.equal(((previousStabilityPoolSnapshot.stabilityPoolState?.users[actorAddress]?.stake) || BigInt(0)) + amount);

    expect(
      newStabilityPoolSnapshot.stabilityPoolState?.users[actorAddress]?.rewardSnapshot,
      'users[msg.sender].rewardSnapshot should be equal to totalRewardPerToken.'
    ).to.equal(newStabilityPoolSnapshot.stabilityPoolState?.totalRewardPerToken);

    expect(
      newStabilityPoolSnapshot.stabilityPoolState?.users[actorAddress]?.collateralSnapshot,
      'users[msg.sender].collateralSnapshot should be equal to totalCollateralPerToken.'
    ).to.equal(newStabilityPoolSnapshot.stabilityPoolState?.totalCollateralPerToken);

    expect(
      newStabilityPoolSnapshot.stabilityPoolState?.users[actorAddress]?.cumulativeProductScalingFactor,
      'users[msg.sender].cumulativeProductScalingFactor should be equal to stakeScalingFactor.'
    ).to.equal(newStabilityPoolSnapshot.stabilityPoolState?.stakeScalingFactor);

    expect(
      newStabilityPoolSnapshot.stabilityPoolState?.users[actorAddress]?.stakeResetCount,
      'users[msg.sender].stakeResetCount should be equal to stakeResetCount.'
    ).to.equal(newStabilityPoolSnapshot.stabilityPoolState?.stakeResetCount);

    // Validate Total Stake
    expect(
      newStabilityPoolSnapshot.stabilityPoolState?.totalStakedRaw,
      'totalStakedRaw should be increased by _amount.'
    ).to.equal(((previousStabilityPoolSnapshot.stabilityPoolState?.totalStakedRaw) || BigInt(0)) + amount);

    // Validate Token Transfer (DFIDToken)
    expect(newStabilityPoolDFIDBalance, "StabilityPool's DFIDToken balance should increase by amount").to.equal(previousStabilityPoolDFIDBalance + amount);
    expect(newActorDFIDBalance, "Actor's DFIDToken balance should decrease by amount").to.equal(previousActorDFIDBalance - amount);

    // Additional validations for SBR rewards, distribution status can be added here if relevant state variables are available in the snapshots.

    return true;
  }
}
