import { ethers } from 'ethers';
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';

class StakeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('StakeAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Parameter Generation
    // The `_amount` parameter must be a positive integer representing the amount of tokens to stake. It should be greater than 0.
    // It should be a valid value upto max token balance available with the user
    let amount = BigInt(0);
    try {
      const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
      const userBalance = dfidTokenSnapshot.Balance[actor.account.address] || BigInt(0);
      if (userBalance > BigInt(0)) {
          amount = BigInt(Math.floor(context.prng.next() % Number(userBalance))) + BigInt(1); // Ensure amount > 0 and less than user balance
      }
    } catch (error) {
      console.error("Error accessing token balance from snapshot:", error);
      //If there is an error, we will skip this action
      return [[], {}];
    }
    
    // The `frontend` parameter should be a valid Ethereum address. If there is no frontend, it can be set to the zero address (0x0000000000000000000000000000000000000000).
    const frontend = ethers.ZeroAddress; // Use zero address if no frontend
    // The `fee` parameter should be a uint256 representing the fee to be charged, expressed in basis points (e.g., 100 for 1%). It should be less than or equal to BASIS_POINTS_DIVISOR.
    const fee = BigInt(Math.floor(context.prng.next() % 100)); // Fee in basis points, up to 99

    const stakeParams = [amount, frontend, fee];
    return [stakeParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const stakeParams = actionParams;
    if (stakeParams.length === 0) {
          console.warn("Skipping execute due to empty stakeParams");
          return;
    }
    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .stake(...stakeParams);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const stakeParams = actionParams;

      if (stakeParams.length === 0) {
          console.warn("Skipping validate due to empty stakeParams");
          return true;
      }

    const amount = stakeParams[0];
    const frontend = stakeParams[1];
    const fee = stakeParams[2];

    // Access the before and after snapshots
    const previousStabilityPoolState = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolState = newSnapshot.contractSnapshot.stabilityPool;
    const previousDFIDTokenState = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenState = newSnapshot.contractSnapshot.dfidToken;

    // Get user stake before and after
    const previousUserStake = previousStabilityPoolState.users[actor.account.address]?.stake || BigInt(0);
    const newUserStake = newStabilityPoolState.users[actor.account.address]?.stake || BigInt(0);

    // Get total staked raw amount before and after
    const previousTotalStakedRaw = previousStabilityPoolState.totalStakedRaw;
    const newTotalStakedRaw = newStabilityPoolState.totalStakedRaw;

    // Get token balances before and after. Handle the cases when balances don't exist
    let previousUserDFIDBalance = BigInt(0);
    let newUserDFIDBalance = BigInt(0);
    let previousContractDFIDBalance = BigInt(0);
    let newContractDFIDBalance = BigInt(0);

    try {
        previousUserDFIDBalance = previousDFIDTokenState.Balance[actor.account.address] || BigInt(0);
        newUserDFIDBalance = newDFIDTokenState.Balance[actor.account.address] || BigInt(0);
        previousContractDFIDBalance = previousDFIDTokenState.Balance[this.contract.target] || BigInt(0);
        newContractDFIDBalance = newDFIDTokenState.Balance[this.contract.target] || BigInt(0);
    } catch (error) {
        console.error("Error accessing token balances:", error);
    }

    // User stake validation
    expect(newUserStake).to.equal(previousUserStake + amount, "User's stake should increase by the staked amount");

    // Total staked amount validation
    expect(newTotalStakedRaw).to.equal(previousTotalStakedRaw + amount, 'Total staked amount should increase by the staked amount');

    //Token Balance Validations
    expect(newUserDFIDBalance).to.equal(previousUserDFIDBalance - amount, "User's staking token balance should decrease by the staked amount");
    expect(newContractDFIDBalance).to.equal(previousContractDFIDBalance + amount, "Contract's staking token balance should increase by the staked amount");

    return true;
  }
}

export default StakeAction;
