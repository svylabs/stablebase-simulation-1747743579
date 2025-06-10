import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class StakeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("StakeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const actorAddress = actor.account.address;
    const actorDfidBalance = currentSnapshot.accountSnapshot[actorAddress] || BigInt(0);

    if (actorDfidBalance <= BigInt(0)) {
      return [false, {}, {}];
    }

    let _amount:bigint;
    if (actorDfidBalance > BigInt(0)) {
         _amount = BigInt(Math.floor(context.prng.next() % Number(actorDfidBalance)));
    } else {
        _amount = BigInt(0);
    }


    const frontend = ethers.ZeroAddress;  // Can be a valid address or zero address
    const fee = BigInt(0); //  No fee for now, 0 represents 0% fee.

    const actionParams = {
      _amount: _amount,
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
    const { _amount, frontend, fee } = actionParams;
    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .stake(_amount, frontend, fee);

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

    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    const previousUserStake = previousStabilityPoolSnapshot.users?.[actorAddress]?.stake || BigInt(0);
    const newUserStake = newStabilityPoolSnapshot.users?.[actorAddress]?.stake || BigInt(0);

    const previousTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw || BigInt(0);
    const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw || BigInt(0);

        //Cumulative scaling factor
    const previousCumulativeProductScalingFactor = previousStabilityPoolSnapshot.users?.[actorAddress]?.cumulativeProductScalingFactor || BigInt(0);
    const newCumulativeProductScalingFactor = newStabilityPoolSnapshot.users?.[actorAddress]?.cumulativeProductScalingFactor || BigInt(0);

        //Stake reset count
    const previousStakeResetCount = previousStabilityPoolSnapshot.users?.[actorAddress]?.stakeResetCount || BigInt(0);
    const newStakeResetCount = newStabilityPoolSnapshot.users?.[actorAddress]?.stakeResetCount || BigInt(0);

        //Stake Scaling Factor and Stake Reset Count
    const stakeScalingFactor = newStabilityPoolSnapshot.stakeScalingFactor || BigInt(0);
    const stakeResetCount = newStabilityPoolSnapshot.stakeResetCount || 0;

    // Account balance validation
    const previousActorBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    const newActorBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    expect(newActorBalance).to.equal(previousActorBalance - _amount, "Actor balance should decrease by staked amount");

    // Contract balance validation
    const previousContractBalance = previousSnapshot.accountSnapshot[this.contract.target] || BigInt(0);
    const newContractBalance = newSnapshot.accountSnapshot[this.contract.target] || BigInt(0);
     expect(newContractBalance).to.equal(previousContractBalance + _amount, "Contract balance should increase by staked amount");



    expect(newUserStake).to.equal(previousUserStake + _amount, "User stake should increase by staked amount");
    expect(newTotalStakedRaw).to.equal(previousTotalStakedRaw + _amount, "Total staked raw should increase by staked amount");
        expect(newCumulativeProductScalingFactor).to.equal(stakeScalingFactor, "Cumulative Product Scaling Factor should be updated");
        expect(newStakeResetCount).to.equal(BigInt(stakeResetCount), "Stake Reset Count should be updated");

    // Additional validations can be added based on the provided action details and context.

    return true;
  }
}
