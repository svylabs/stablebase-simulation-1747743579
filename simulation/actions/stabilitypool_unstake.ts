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

    if (!stabilityPoolSnapshot.userInfos[userAddress]) {
      console.log("User has no stake in StabilityPool");
      return [false, {}, {}];
    }

    const userStake = stabilityPoolSnapshot.userInfos[userAddress].stake;

    if (userStake <= BigInt(0)) {
      console.log("User has no stake to unstake");
      return [false, {}, {}];
    }

    // Ensure amountToUnstake is within the valid range (0, userStake]
    const amountToUnstake = BigInt(Math.floor(context.prng.next() % Number(userStake) + 1));

    const actionParams = {
      amount: amountToUnstake,
      frontend: ethers.ZeroAddress, // Address 0 for no frontend
      fee: BigInt(0), // Fee is 0
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const signer = actor.account.value.connect(context.provider);
    return this.contract.connect(signer).unstake(actionParams.amount, actionParams.frontend, actionParams.fee);
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const amountUnstaked = actionParams.amount;
    const userAddress = actor.account.address;

    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

    const previousUserStake = previousStabilityPoolSnapshot.userInfos?.[userAddress]?.stake || BigInt(0);
    const newUserStake = newStabilityPoolSnapshot.userInfos?.[userAddress]?.stake || BigInt(0);

    const previousTotalStakedRaw = previousStabilityPoolSnapshot?.totalStakedRaw || BigInt(0);
    const newTotalStakedRaw = newStabilityPoolSnapshot?.totalStakedRaw || BigInt(0);

    const previousUserDFIDTokenBalance = previousDFIDTokenSnapshot.balances?.[userAddress] || BigInt(0);
    const newUserDFIDTokenBalance = newDFIDTokenSnapshot.balances?.[userAddress] || BigInt(0);

    // Stake Reduction
    expect(newUserStake, "User stake should be decreased by the unstaked amount.").to.equal(previousUserStake - amountUnstaked);

    // Total Stake Reduction
    expect(newTotalStakedRaw, "Total staked amount should be decreased by the unstaked amount.").to.equal(previousTotalStakedRaw - amountUnstaked);

    // Token Transfer to User
    expect(newUserDFIDTokenBalance, "User's staking token balance should increase by the unstaked amount.").to.equal(previousUserDFIDTokenBalance + amountUnstaked);

     // Validate rewardSenderActive if totalStakedRaw becomes 0
    if (previousStabilityPoolSnapshot.rewardSenderActive) {
        if (newTotalStakedRaw === BigInt(0)) {
            expect(newStabilityPoolSnapshot.rewardSenderActive, "rewardSenderActive should be false when totalStakedRaw is 0").to.be.false;
        } else {
            expect(newStabilityPoolSnapshot.rewardSenderActive, "rewardSenderActive should remain true when totalStakedRaw is not 0").to.be.true;
        }
    }

    // Additional validations based on action summary, where applicable
    const sbrRewardDistributionStatus = previousStabilityPoolSnapshot.sbrRewardDistributionStatus;    

    // Validate user reward snapshots are updated
     if(previousStabilityPoolSnapshot.userInfos?.[userAddress]){
         expect(newStabilityPoolSnapshot.userInfos[userAddress].rewardSnapshot).to.not.be.undefined;
         expect(newStabilityPoolSnapshot.userInfos[userAddress].collateralSnapshot).to.not.be.undefined;
         expect(newStabilityPoolSnapshot.userInfos[userAddress].cumulativeProductScalingFactor).to.not.be.undefined;
         expect(newStabilityPoolSnapshot.userInfos[userAddress].stakeResetCount).to.not.be.undefined;
     }

    return true;
  }
}
