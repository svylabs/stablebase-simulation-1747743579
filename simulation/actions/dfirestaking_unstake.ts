import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

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
    const dfireStakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
    const stakeInfo = dfireStakingSnapshot.stakes[actor.account.address];

    if (!stakeInfo || stakeInfo.stake === BigInt(0)) {
      return [false, {}, {}];
    }

    const maxUnstakeAmount = stakeInfo.stake;
    const amountToUnstake = BigInt(context.prng.next()) % (maxUnstakeAmount + BigInt(1));

    if (amountToUnstake <= BigInt(0)) {
      return [false, {}, {}];
    }

    const actionParams = {
      _amount: amountToUnstake,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .unstake(actionParams._amount);

    return { tx: tx, result: null };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const amountToUnstake = actionParams._amount;

    const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;
    const previousDFIRETokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
    const newDFIRETokenSnapshot = newSnapshot.contractSnapshot.dfireToken;

    const previousUserStake = previousDFIREStakingSnapshot.stakes[actor.account.address]?.stake || BigInt(0);
    const newUserStake = newDFIREStakingSnapshot.stakes[actor.account.address]?.stake || BigInt(0);
    const previousTotalStake = previousDFIREStakingSnapshot.totalStakeValue;
    const newTotalStake = newDFIREStakingSnapshot.totalStakeValue;
    const previousUserDFIREBalance = previousDFIRETokenSnapshot.balances[actor.account.address] || BigInt(0);
    const newUserDFIREBalance = newDFIRETokenSnapshot.balances[actor.account.address] || BigInt(0);
    const previousContractDFIREBalance = previousDFIRETokenSnapshot.balances[this.contract.target] || BigInt(0);
    const newContractDFIREBalance = newDFIRETokenSnapshot.balances[this.contract.target] || BigInt(0);
    const previousRewardSnapshot = previousDFIREStakingSnapshot.stakes[actor.account.address]?.rewardSnapshot || BigInt(0);
    const newRewardSnapshot = newDFIREStakingSnapshot.stakes[actor.account.address]?.rewardSnapshot || BigInt(0);
    const totalRewardPerToken = newDFIREStakingSnapshot.totalRewardPerTokenValue;
    const previousCollateralSnapshot = previousDFIREStakingSnapshot.stakes[actor.account.address]?.collateralSnapshot || BigInt(0);
    const newCollateralSnapshot = newDFIREStakingSnapshot.stakes[actor.account.address]?.collateralSnapshot || BigInt(0);
    const totalCollateralPerToken = newDFIREStakingSnapshot.totalCollateralPerTokenValue;


    expect(newUserStake).to.equal(previousUserStake - amountToUnstake, "User stake should decrease by unstaked amount");
    expect(newTotalStake).to.equal(previousTotalStake - amountToUnstake, "Total stake should decrease by unstaked amount");
    expect(newUserDFIREBalance).to.equal(previousUserDFIREBalance + amountToUnstake, "User DFIRE balance should increase by unstaked amount");
    expect(newContractDFIREBalance).to.equal(previousContractDFIREBalance - amountToUnstake, "Contract DFIRE balance should decrease by unstaked amount");
    expect(newRewardSnapshot).to.equal(totalRewardPerToken, "Reward snapshot should be updated to totalRewardPerToken");
    expect(newCollateralSnapshot).to.equal(totalCollateralPerToken, "Collateral snapshot should be updated to totalCollateralPerToken");

    // Additional checks for reward and collateral claims can be added here based on the emitted events.

    return true;
  }
}
