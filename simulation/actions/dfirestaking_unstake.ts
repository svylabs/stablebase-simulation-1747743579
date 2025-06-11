import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class UnstakeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("UnstakeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
    const actorAddress = actor.account.address;
    const userStake = stakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);

    if (userStake <= BigInt(0)) {
      return [false, {}, {}]; // Cannot unstake if stake is zero or negative
    }

    // Generate a random amount to unstake, but not more than the current stake
    const maxUnstakeAmount = userStake;
    const unstakeAmount = BigInt(context.prng.next()) % (maxUnstakeAmount + BigInt(1)); // Ensure amount is within stake

    if (unstakeAmount <= BigInt(0)) {
      return [false, {}, {}];
    }

    const params = {
      _amount: unstakeAmount,
    };

    return [true, params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { _amount } = actionParams;

    const tx = await this.contract.connect(actor.account.value).unstake(_amount);
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
    const { _amount } = actionParams;
    const actorAddress = actor.account.address;

    const previousStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;
    const previousDFIRETokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
    const newDFIRETokenSnapshot = newSnapshot.contractSnapshot.dfireToken;

    // Validate User Stake
    const previousUserStake = previousStakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);
    const newUserStake = newStakingSnapshot.stakes[actorAddress]?.stake || BigInt(0);
    expect(newUserStake, "User stake should decrease by _amount").to.equal(previousUserStake - _amount);

    // Validate Total Stake
    const previousTotalStake = previousStakingSnapshot.totalStake;
    const newTotalStake = newStakingSnapshot.totalStake;
    expect(newTotalStake, "Total stake should decrease by _amount").to.equal(previousTotalStake - _amount);

    // Validate stakingToken balance of user (msg.sender)
    const previousUserDFIREBalance = previousDFIRETokenSnapshot.tokenBalances[actorAddress] || BigInt(0);
    const newUserDFIREBalance = newDFIRETokenSnapshot.tokenBalances[actorAddress] || BigInt(0);
    expect(newUserDFIREBalance, "User's DFIRE balance should increase by _amount").to.equal(previousUserDFIREBalance + _amount);

    // Validate stakingToken balance of DFIREStaking contract
    const contractAddress = this.contract.target;
    const previousContractDFIREBalance = previousDFIRETokenSnapshot.tokenBalances[contractAddress] || BigInt(0);
    const newContractDFIREBalance = newDFIRETokenSnapshot.tokenBalances[contractAddress] || BigInt(0);
    expect(newContractDFIREBalance, "Contract's DFIRE balance should decrease by _amount").to.equal(previousContractDFIREBalance - _amount);

    // Validate Reward Snapshot (basic check, assuming totalRewardPerToken updates)
    const previousUserRewardSnapshot = previousStakingSnapshot.stakes[actorAddress]?.rewardSnapshot || BigInt(0);
    const newUserRewardSnapshot = newStakingSnapshot.stakes[actorAddress]?.rewardSnapshot || BigInt(0);
    expect(newUserRewardSnapshot, "User's reward snapshot should be updated to totalRewardPerToken").to.equal(newStakingSnapshot.totalRewardPerToken);

    // Validate Collateral Snapshot (basic check, assuming totalCollateralPerToken updates)
    const previousUserCollateralSnapshot = previousStakingSnapshot.stakes[actorAddress]?.collateralSnapshot || BigInt(0);
    const newUserCollateralSnapshot = newStakingSnapshot.stakes[actorAddress]?.collateralSnapshot || BigInt(0);
    expect(newUserCollateralSnapshot, "User's collateral snapshot should be updated to totalCollateralPerToken").to.equal(newStakingSnapshot.totalCollateralPerToken);

    // Validate Unstaked and Claimed events
    let unstakedEventFound = false;
    let claimedEventFound = false;
    let rewardAmount = BigInt(0);
    let collateralRewardAmount = BigInt(0);

    for (const log of executionReceipt.logs) {
      if (log.address === this.contract.target) {
        try {
          const parsedLog = this.contract.interface.parseLog(log);

          if (parsedLog && parsedLog.name === "Unstaked") {
            expect(parsedLog.args[0], "Unstaked event: User address incorrect").to.equal(actorAddress);
            expect(parsedLog.args[1], "Unstaked event: Unstaked amount incorrect").to.equal(_amount);
            unstakedEventFound = true;
          }

          if (parsedLog && parsedLog.name === "Claimed") {
            expect(parsedLog.args[0], "Claimed event: User address incorrect").to.equal(actorAddress);
            rewardAmount = parsedLog.args[1];
            collateralRewardAmount = parsedLog.args[2];
            claimedEventFound = true;
          }
        } catch (error) { // Catch errors when parsing events
          console.warn("Error parsing log:", error);
          continue; // Skip to the next log
        }
      }
    }

    expect(unstakedEventFound, "Unstaked event should be emitted").to.be.true;
    expect(claimedEventFound, "Claimed event should be emitted").to.be.true;

    // Validate rewardSenderActive and stableBaseContract interaction
    const previousRewardSenderActive = previousStakingSnapshot.rewardSenderActive;
    const newRewardSenderActive = newStakingSnapshot.rewardSenderActive;
    const previousTotalStake = previousStakingSnapshot.totalStake;
    const totalStakeAfterUnstake = newStakingSnapshot.totalStake;

    if (previousRewardSenderActive && previousTotalStake !== BigInt(0) && totalStakeAfterUnstake === BigInt(0)) {
      let setCanSBRStakingPoolReceiveRewardsEventFound = false;

      const stableBaseContractAddress = (context.contracts.stableBaseCDP as any).target;
      const stableBaseContract = context.contracts.stableBaseCDP as any;

      for (const log of executionReceipt.logs) {
        if (log.address === stableBaseContractAddress) {
          try {
            const parsedLog = stableBaseContract.interface.parseLog(log);

            if (parsedLog && parsedLog.name === "SetCanSBRStakingPoolReceiveRewards") {
              expect(parsedLog.args[0], "SetCanSBRStakingPoolReceiveRewards event: should be false").to.equal(false);
              setCanSBRStakingPoolReceiveRewardsEventFound = true;
              break;
            }
          } catch (error) {
            console.warn("Error parsing log:", error);
            continue;
          }
        }
      }
      expect(setCanSBRStakingPoolReceiveRewardsEventFound, "SetCanSBRStakingPoolReceiveRewards event should be emitted").to.be.true;
      expect(newRewardSenderActive, "rewardSenderActive should be false").to.be.false; // Validate state change
    }
    else{
        expect(newRewardSenderActive).to.equal(previousRewardSenderActive, "rewardSenderActive should not change");
    }

    return true;
  }
}
