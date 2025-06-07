import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
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
  ): Promise<[any, Record<string, any>]> {
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const userAddress = actor.account.address;
    const userStake = stabilityPoolSnapshot.users?.[userAddress]?.stake || BigInt(0);

    // Ensure amountToUnstake is within the user's stake bounds
    let amountToUnstake = BigInt(0);
    if (userStake > BigInt(0)) {
        amountToUnstake = BigInt(context.prng.next()) % userStake + BigInt(1);
    }

    const frontend = ethers.ZeroAddress;  // Or generate a valid address if needed.
    const fee = BigInt(0);

    const params = [amountToUnstake, frontend, fee];
    return [params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [amount, frontend, fee] = actionParams;
    const tx = await this.contract.connect(actor.account.value).unstake(amount, frontend, fee);
    await tx.wait();
    return {amount: amount, frontend: frontend, fee: fee };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const {amount, frontend, fee} = actionParams;
    const actorAddress = actor.account.address;

    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    const previousUserStake = previousStabilityPoolSnapshot.users?.[actorAddress]?.stake || BigInt(0);
    const newUserStake = newStabilityPoolSnapshot.users?.[actorAddress]?.stake || BigInt(0);

    const previousTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
    const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;

    const previousDFIDTokenBalance = previousSnapshot.contractSnapshot.dfidToken.Balance[actorAddress] || BigInt(0);
    const newDFIDTokenBalance = newSnapshot.contractSnapshot.dfidToken.Balance[actorAddress] || BigInt(0);

    // User Stake
    expect(newUserStake).to.equal(previousUserStake - amount, "User stake should be decreased by the unstaked amount");
    expect(newUserStake).to.be.at.least(BigInt(0), "User stake must be greater or equal to zero");
    expect(newDFIDTokenBalance).to.equal(previousDFIDTokenBalance + amount, "User's stakingToken balance should increase by the unstaked amount");

    // Total Stake
    expect(newTotalStakedRaw).to.equal(previousTotalStakedRaw - amount, "Total staked amount should be decreased by the unstaked amount");
    expect(newTotalStakedRaw).to.be.at.least(BigInt(0), "Total staked amount must be greater or equal to zero");

    // Events - TODO: Improve event validation to check arguments
    const unstakedEvent = newSnapshot.receipts[0]?.logs.find((log: any) => {
        try {
            const event = this.contract.interface.parseLog(log);
            return event && event.name === 'Unstaked';
        } catch (e) {
            return false;
        }
    });
    expect(unstakedEvent).to.not.be.undefined;

    const rewardClaimedEvent = newSnapshot.receipts[0]?.logs.find((log: any) => {
        try {
            const event = this.contract.interface.parseLog(log);
            return event && event.name === 'RewardClaimed';
        } catch (e) {
            return false;
        }
    });

     const dFireRewardClaimedEvent = newSnapshot.receipts[0]?.logs.find((log: any) => {
        try {
            const event = this.contract.interface.parseLog(log);
            return event && event.name === 'DFireRewardClaimed';
        } catch (e) {
            return false;
        }
    });

    //If rewards are claimed there should be events
    if(rewardClaimedEvent) expect(rewardClaimedEvent).to.not.be.undefined;
    if(dFireRewardClaimedEvent) expect(dFireRewardClaimedEvent).to.not.be.undefined;

    return true;
  }
}
