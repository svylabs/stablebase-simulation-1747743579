import { ethers } from 'ethers';
import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
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
  ): Promise<[any, Record<string, any>]> {
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const userAddress = actor.account.address;
    const userStake = stabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);

    // Ensure the user has a stake to unstake
    if (userStake <= BigInt(0)) {
      console.warn(`User ${userAddress} has no stake to unstake.`);
      return [[BigInt(0)], {}]; // Return 0 amount, so it wont execute.
    }

    // Generate a random amount to unstake, up to the user's current stake
    const maxUnstakeAmount = userStake;
    const amount = BigInt(Math.floor(context.prng.next() / 4294967296 * Number(maxUnstakeAmount)));

    // Ensure amount is greater than zero to prevent revert
    const unstakeAmount = amount > BigInt(0) ? amount : BigInt(1);

    const params = [unstakeAmount];
    return [params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const amount = actionParams[0];
    if (amount <= BigInt(0)) return;
    const tx = await this.contract.connect(actor.account.value).unstake(amount);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const amount = actionParams[0];
    if (amount <= BigInt(0)) return true;

    const userAddress = actor.account.address;

    const oldStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
    const oldDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    
    const oldUserStake = oldStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);
    const newUserStake = newStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);
    const oldTotalStakedRaw = oldStabilityPoolSnapshot.totalStakedRaw;
    const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;
    const oldUserRewardSnapshot = oldStabilityPoolSnapshot.users[userAddress]?.rewardSnapshot || BigInt(0);
    const newUserRewardSnapshot = newStabilityPoolSnapshot.users[userAddress]?.rewardSnapshot || BigInt(0);
    const oldUserCollateralSnapshot = oldStabilityPoolSnapshot.users[userAddress]?.collateralSnapshot || BigInt(0);
    const newUserCollateralSnapshot = newStabilityPoolSnapshot.users[userAddress]?.collateralSnapshot || BigInt(0);
    const oldTotalRewardPerToken = oldStabilityPoolSnapshot.totalRewardPerToken;
    const newTotalRewardPerToken = newStabilityPoolSnapshot.totalRewardPerToken;
    const oldTotalCollateralPerToken = oldStabilityPoolSnapshot.totalCollateralPerToken;
    const newTotalCollateralPerToken = newStabilityPoolSnapshot.totalCollateralPerToken;
    const oldSbrRewardSnapshot = oldStabilityPoolSnapshot.sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0);
    const newSbrRewardSnapshot = newStabilityPoolSnapshot.sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0);
    const oldTotalSbrRewardPerToken = oldStabilityPoolSnapshot.totalSbrRewardPerToken;
    const newTotalSbrRewardPerToken = newStabilityPoolSnapshot.totalSbrRewardPerToken;
    const oldRewardSenderActive = oldStabilityPoolSnapshot.rewardSenderActive;
    const newRewardSenderActive = newStabilityPoolSnapshot.rewardSenderActive;

    const dfidTokenAddress = (context.contracts.dfidToken as any).target;
    const oldContractDfidBalance = previousSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);
    const newContractDfidBalance = newSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);
    const oldUserAccountBalance = previousSnapshot.accountSnapshot[userAddress] || BigInt(0);
    const newUserAccountBalance = newSnapshot.accountSnapshot[userAddress] || BigInt(0);

    const oldDfidTokenBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalance;
    const newDfidTokenBalance = newSnapshot.contractSnapshot.dfidToken.accountBalance;

    // Validate User Stake
    expect(newUserStake, "User's stake should be decreased by the unstaked amount.").to.equal(oldUserStake - amount);

    // Validate Total Staked
    expect(newTotalStakedRaw, "Total staked should be decreased by the unstaked amount.").to.equal(oldTotalStakedRaw - amount);

    // Validate stakingToken transfer to user
    expect(newDfidTokenBalance, "DFID Token balance of user should have increased").to.equal(oldDfidTokenBalance + amount);

     // Validate user's account balance increase
     expect(newUserAccountBalance, "User's account balance should increase by the unstaked amount").to.equal(oldUserAccountBalance);

    // Validate Reward Snapshots are updated if rewards are claimed
    if (newTotalRewardPerToken > oldTotalRewardPerToken) {
        expect(newUserRewardSnapshot, "User's rewardSnapshot should be updated to totalRewardPerToken.").to.equal(newTotalRewardPerToken);
        expect(newUserCollateralSnapshot, "User's collateralSnapshot should be updated to totalCollateralPerToken.").to.equal(newTotalCollateralPerToken);
    }

    // Validate SBR Reward Snapshots are updated if SBR rewards are claimed
    if (newTotalSbrRewardPerToken > oldTotalSbrRewardPerToken) {
        expect(newSbrRewardSnapshot, "User's sbrRewardSnapshot should be updated to totalSbrRewardPerToken.").to.equal(newTotalSbrRewardPerToken);
    }

     // Validate rewardSenderActive is set to false when totalStakedRaw is 0
     if (oldTotalStakedRaw > BigInt(0) && newTotalStakedRaw === BigInt(0)) {
      expect(newRewardSenderActive, 'rewardSenderActive should be false when totalStakedRaw is 0').to.be.false;
    }

    return true;
  }
}
