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
    const stakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
    const userAddress = actor.account.address;

    if (!stakingSnapshot.stakes[userAddress]) {
      console.log("User has no stake in the contract");
      return [false, {}, {}];
    }

    const userStake = stakingSnapshot.stakes[userAddress].stake;
    if (userStake <= BigInt(0)) {
      console.log("User has no stake.");
      return [false, {}, {}];
    }

    const canExecute = stakingSnapshot.totalRewardPerToken > stakingSnapshot.stakes[userAddress].rewardSnapshot || stakingSnapshot.totalCollateralPerToken > stakingSnapshot.stakes[userAddress].collateralSnapshot;

    if (!canExecute) {
        console.log("No rewards to claim.");
        return [false, {}, {}];
    }

    return [true, {}, {}];
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
    const userAddress = actor.account.address;
    const previousStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

    const previousRewardTokenBalance = previousSnapshot.contractSnapshot.dfidToken.balances[userAddress] || BigInt(0);
    const newRewardTokenBalance = newSnapshot.contractSnapshot.dfidToken.balances[userAddress] || BigInt(0);

    const previousEthBalance = previousSnapshot.accountSnapshot[userAddress] || BigInt(0);
    const newEthBalance = newSnapshot.accountSnapshot[userAddress] || BigInt(0);

    const previousUserStakeInfo = previousStakingSnapshot.stakes[userAddress] || {stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0)};
    const newUserStakeInfo = newStakingSnapshot.stakes[userAddress] || {stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0)};

    const totalRewardPerToken = newStakingSnapshot.totalRewardPerToken;
    const totalCollateralPerToken = newStakingSnapshot.totalCollateralPerToken;
    const stake = previousUserStakeInfo.stake;
    const precision = previousStakingSnapshot.precision;

    const expectedReward = ((totalRewardPerToken - previousUserStakeInfo.rewardSnapshot) * stake) / precision;
    const expectedCollateralReward = ((totalCollateralPerToken - previousUserStakeInfo.collateralSnapshot) * stake) / precision;

    // User Balance Validations
    expect(newRewardTokenBalance - previousRewardTokenBalance).to.equal(expectedReward, "Reward token balance should increase by the calculated reward amount");
    expect(newEthBalance - previousEthBalance).to.equal(expectedCollateralReward, "ETH balance should increase by the calculated collateral reward amount");

    // User reward snapshot validations
    expect(newUserStakeInfo.rewardSnapshot).to.equal(totalRewardPerToken, "User's rewardSnapshot should be equal to totalRewardPerToken after claiming");
    expect(newUserStakeInfo.collateralSnapshot).to.equal(totalCollateralPerToken, "User's collateralSnapshot should be equal to totalCollateralPerToken after claiming");

    // Event Emission Validations
    const claimedEvent = executionReceipt.receipt.logs.find((log) => {
      try {
        const parsedLog = this.contract.interface.parseLog(log);
        return parsedLog.name === "Claimed";
      } catch (e) {
        return false;
      }
    });

    if (claimedEvent) {
      const parsedLog = this.contract.interface.parseLog(claimedEvent);
      expect(parsedLog.args.account).to.equal(userAddress, "Claimed event should emit the correct user address");
      expect(parsedLog.args.reward).to.equal(expectedReward, "Claimed event should emit the correct reward amount");
      expect(parsedLog.args.collateralReward).to.equal(expectedCollateralReward, "Claimed event should emit the correct collateral reward amount");
    } else {
      expect.fail("Claimed event was not emitted");
      return false;
    }

    // Contract Invariants Validations
    expect(newStakingSnapshot.totalRewardPerToken).to.equal(previousStakingSnapshot.totalRewardPerToken, "totalRewardPerToken should remain unchanged");
    expect(newStakingSnapshot.totalCollateralPerToken).to.equal(previousStakingSnapshot.totalCollateralPerToken, "totalCollateralPerToken should remain unchanged");
    expect(newStakingSnapshot.totalStake).to.equal(previousStakingSnapshot.totalStake, "totalStake should remain unchanged");

    return true;
  }
}
