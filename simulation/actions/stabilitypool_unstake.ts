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
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const userAddress = actor.account.address;
    const userStake = stabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);

    if (userStake <= BigInt(0)) {
      return [false, {}, {}];
    }

    let amountToUnstake = BigInt(Math.floor(context.prng.next() % Number(userStake + BigInt(1))));
    if (amountToUnstake > userStake) {
         amountToUnstake = userStake; // Ensure amountToUnstake is not greater than userStake
    }

    const frontend = ethers.ZeroAddress; // Optional, can be zero address
    const fee = BigInt(0); // Optional, defaults to 0

    const actionParams = {
      amount: amountToUnstake,
      frontend: frontend,
      fee: fee,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { amount, frontend, fee } = actionParams;
    const tx = await this.contract.connect(actor.account.value).unstake(amount, frontend, fee);
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
    const { amount, frontend, fee } = actionParams;
    const userAddress = actor.account.address;

    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    const previousUserStabilityPoolData = previousStabilityPoolSnapshot.users[userAddress] || {
                stake: BigInt(0),
                rewardSnapshot: BigInt(0),
                collateralSnapshot: BigInt(0),
                cumulativeProductScalingFactor: BigInt(0),
                stakeResetCount: BigInt(0)
            };
    const newUserStabilityPoolData = newStabilityPoolSnapshot.users[userAddress] || {
                stake: BigInt(0),
                rewardSnapshot: BigInt(0),
                collateralSnapshot: BigInt(0),
                cumulativeProductScalingFactor: BigInt(0),
                stakeResetCount: BigInt(0)
            };

    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

    const previousUserAccountSnapshot = previousSnapshot.accountSnapshot[userAddress] || BigInt(0);
    const newUserAccountSnapshot = newSnapshot.accountSnapshot[userAddress] || BigInt(0);

    const stakeTokenAddress = (context.contracts.dfidToken as any).target;

        const previousUserTokenBalance = previousSnapshot.accountSnapshot[stakeTokenAddress] || BigInt(0);
        const newUserTokenBalance = newSnapshot.accountSnapshot[stakeTokenAddress] || BigInt(0);

    // User Stake Validation
    const previousUserStake = previousUserStabilityPoolData.stake;
    const newUserStake = newUserStabilityPoolData.stake;
    expect(newUserStake, "User stake should decrease by the unstaked amount").to.equal(previousUserStake - amount);
    expect(newUserStake, "User stake should be non-negative").to.be.at.least(BigInt(0));

    // Total Staked Validation
    const previousTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
    const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;
    expect(newTotalStakedRaw, "Total staked raw should decrease by the unstaked amount").to.equal(previousTotalStakedRaw - amount);
    expect(newTotalStakedRaw, "Total staked raw should be non-negative").to.be.at.least(BigInt(0));

    // Token Transfer Validation
        const diff = (newUserTokenBalance || BigInt(0)) - (previousUserTokenBalance || BigInt(0));

        expect(diff, "User's stakingToken balance should increase by the unstaked amount").to.equal(amount);

    // Check if rewardSenderActive is set to false when totalStakedRaw becomes zero
    if (previousTotalStakedRaw !== BigInt(0) && newTotalStakedRaw === BigInt(0) && previousStabilityPoolSnapshot.rewardSenderActive) {
        expect(newStabilityPoolSnapshot.rewardSenderActive, "rewardSenderActive should be set to false").to.be.false;
    }

    return true;
  }
}
