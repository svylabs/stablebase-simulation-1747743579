import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class StakeAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("StakeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stakingTokenBalance = currentSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);

    if (stakingTokenBalance <= BigInt(0)) {
      return [false, {}, {}];
    }

    // Ensure amountToStake is within reasonable bounds.
    const maxStakeAmount = stakingTokenBalance;
    const amountToStake = (BigInt(context.prng.next()) % maxStakeAmount) + BigInt(1);

    const params = { _amount: amountToStake };
    return [true, params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { _amount } = actionParams;
    const signer = actor.account.value as ethers.Signer;
    const tx = await this.contract.connect(signer).stake(_amount);
    return { txHash: tx.hash };
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

    // Validate Stake Update
    const previousStake = previousSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address).stake;
    const newStake = newSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address).stake;
    expect(newStake, "User's stake should increase by the staked amount.").to.equal(previousStake + _amount);

    const previousTotalStake = previousSnapshot.contractSnapshot.dfireStaking.totalStake;
    const newTotalStake = newSnapshot.contractSnapshot.dfireStaking.totalStake;
    expect(newTotalStake, "Total stake should increase by the staked amount.").to.equal(previousTotalStake + _amount);

    const previousRewardSnapshot = previousSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address).rewardSnapshot;
    const newRewardSnapshot = newSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address).rewardSnapshot;
    expect(newRewardSnapshot, "Reward snapshot should be updated to totalRewardPerToken.").to.equal(newSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken);

    const previousCollateralSnapshot = previousSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address).collateralSnapshot;
    const newCollateralSnapshot = newSnapshot.contractSnapshot.dfireStaking.getStake(actor.account.address).collateralSnapshot;
    expect(newCollateralSnapshot, "Collateral snapshot should be updated to totalCollateralPerToken.").to.equal(newSnapshot.contractSnapshot.dfireStaking.totalCollateralPerToken);

    // Validate Token Transfers
    const previousContractStakingTokenBalance = previousSnapshot.contractSnapshot.dfireToken.balances[this.contract.target] || BigInt(0);
    const newContractStakingTokenBalance = newSnapshot.contractSnapshot.dfireToken.balances[this.contract.target] || BigInt(0);

    const previousUserStakingTokenBalance = previousSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);
    const newUserStakingTokenBalance = newSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);

    // Account for potential reward claim during stake
    const rewardClaimed = (newSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0)) - (previousSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0));
    const collateralClaimed = (newSnapshot.accountSnapshot[actor.account.address] || BigInt(0)) - (previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0));

    expect(newContractStakingTokenBalance, "Contract staking token balance should increase.").to.equal(previousContractStakingTokenBalance + _amount);

    // Handle potential reward and collateral claims
    let expectedUserStakingTokenBalance = previousUserStakingTokenBalance - _amount;

    if (rewardClaimed > 0) {
        // Adjust expected balance for reward claim.
    }
    if (collateralClaimed > 0) {
        // Adjust expected balance for collateral claim
    }

    expect(newUserStakingTokenBalance, "User staking token balance should decrease accounting for claims.").to.equal(expectedUserStakingTokenBalance + (rewardClaimed > 0 ? 0n : 0n) + (collateralClaimed > 0 ? 0n : 0n));

    // Validate Reward Sender Interaction
    const rewardSenderActive = previousSnapshot.contractSnapshot.dfireStaking.rewardSenderActive;
    const previousTotalStakePreStake = previousSnapshot.contractSnapshot.dfireStaking.totalStake;

    if (rewardSenderActive && previousTotalStakePreStake === BigInt(0)) {
      let eventFound = false;
      for (const log of executionReceipt.logs) {
        try {
          // Assuming the event is emitted by stableBaseContract and has the name 'CanSBRStakingPoolReceiveRewardsSet'
          // and that the interface of stableBaseContract is available.
          const parsedLog = context.contracts.stableBaseCDP.interface.parseLog(log);
          if (parsedLog && parsedLog.name === "CanSBRStakingPoolReceiveRewardsSet") {
            eventFound = true;
            break;
          }
        } catch (e) { /* ignore */ }
      }
      expect(eventFound, "CanSBRStakingPoolReceiveRewardsSet event should be emitted by stableBaseContract").to.be.true;
    }

    return true;
  }
}
