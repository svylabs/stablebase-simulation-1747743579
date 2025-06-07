import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
import { expect } from 'chai';

import {
  DFIDTokenSnapshot,
  DFIREStakingSnapshot
} from "./SnapshotInterfaces";

export class ClaimAction extends Action {
  contract: ethers.Contract;
  private readonly precision: bigint;

  constructor(contract: ethers.Contract, precision: bigint) {
    super("ClaimAction");
    this.contract = contract;
    this.precision = precision;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // No parameters are needed for the `claim` function.
    return [[], {}];
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
    actionParams: any
  ): Promise<boolean> {
    const previousDFIREStakingSnapshot: DFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newDFIREStakingSnapshot: DFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;
    const previousDFIDTokenSnapshot: DFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot: DFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

    const actorAddress = actor.account.address;
    const dfireStakingContractAddress = (context.contracts.dfireStaking as ethers.Contract).target;

    // Fetch stake information from snapshots
    const previousStake = previousDFIREStakingSnapshot.stakes[actorAddress] || { stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0) };
    const newStake = newDFIREStakingSnapshot.stakes[actorAddress] || { stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0) };

    // User State Validation
    expect(newStake.rewardSnapshot, "User's rewardSnapshot should be updated to the current totalRewardPerToken").to.equal(newDFIREStakingSnapshot.totalRewardPerToken);
    expect(newStake.collateralSnapshot, "User's collateralSnapshot should be updated to the current totalCollateralPerToken").to.equal(newDFIREStakingSnapshot.totalCollateralPerToken);

    // Calculate expected reward and collateral reward
    const reward = ((newDFIREStakingSnapshot.totalRewardPerToken - previousStake.rewardSnapshot) * previousStake.stake) / this.precision;
    const collateralReward = ((newDFIREStakingSnapshot.totalCollateralPerToken - previousStake.collateralSnapshot) * previousStake.stake) / this.precision;

    // Reward Transfer Validation
    if (reward > BigInt(0)) {
      const previousUserRewardTokenBalance = previousDFIDTokenSnapshot.Balance[actorAddress] || BigInt(0);
      const newUserRewardTokenBalance = newDFIDTokenSnapshot.Balance[actorAddress] || BigInt(0);
      expect(newUserRewardTokenBalance - previousUserRewardTokenBalance, "User's balance of rewardToken should increase by the reward amount.").to.equal(reward);
      const previousContractRewardTokenBalance = previousDFIDTokenSnapshot.Balance[dfireStakingContractAddress] || BigInt(0);
      const newContractRewardTokenBalance = newDFIDTokenSnapshot.Balance[dfireStakingContractAddress] || BigInt(0);
      expect(previousContractRewardTokenBalance - newContractRewardTokenBalance, "Contract's balance of rewardToken should decrease by the reward amount.").to.equal(reward);
    }

    // Collateral Reward Validation
    if (collateralReward > BigInt(0)) {
      const previousUserEthBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
      const newUserEthBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);
      expect(newUserEthBalance - previousUserEthBalance, "User should receive the collateralReward in ETH/Native coin.").to.equal(collateralReward);
    }

    // Event Validation
    const receipt = actionParams.receipt;
    if (receipt && receipt.logs) {
      const claimedEvent = receipt.logs.find(
        (log: any) =>
          log.address === dfireStakingContractAddress &&
          log.topics[0] === ethers.keccak256(ethers.toUtf8Bytes("Claimed(address,uint256,uint256)"))
      );

      if (claimedEvent) {
        const decodedEvent = this.contract.interface.parseLog(claimedEvent);
        expect(decodedEvent.args[0], "Claimed event should have the correct user address").to.equal(actorAddress);
        expect(decodedEvent.args[1], "Claimed event should have the correct reward amount").to.equal(reward);
        expect(decodedEvent.args[2], "Claimed event should have the correct collateral reward amount").to.equal(collateralReward);
      }
    }

    return true;
  }
}
