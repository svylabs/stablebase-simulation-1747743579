import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
import { expect } from "chai";

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
    try {
      const dfireStakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
      const stakesMapping = dfireStakingSnapshot.stakesMapping;
      const userAddress = actor.account.address;

      let maxUnstakeAmount = BigInt(0);
      if (stakesMapping && stakesMapping[userAddress]) {
        maxUnstakeAmount = stakesMapping[userAddress].stake;
      }

      if (maxUnstakeAmount <= BigInt(0)) {
        console.warn("User has no stake to unstake. Setting unstake amount to 0.");
        return [[BigInt(0)], {}];
      }

      // Generate a valid amount to unstake, ensuring it's not greater than the user's stake
      const amountToUnstake = context.prng.next() % (Number(maxUnstakeAmount) + 1);
      const amount = BigInt(amountToUnstake);

      console.log(`Initialize: Amount to unstake: ${amount}`);
      return [[amount], {}];
    } catch (error) {
      console.error("Error in initialize:", error);
      throw error; // Re-throw the error to prevent the action from proceeding
    }
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const amount = actionParams[0];
    const signer = actor.account.value.connect(this.contract.runner!);
    console.log(`Execute: Unstaking amount: ${amount}`);

    try {
      const tx = await signer.unstake(amount);
      console.log("Execute: Transaction sent, waiting for confirmation...");
      await tx.wait();
      console.log("Execute: Transaction confirmed.");
    } catch (error) {
      console.error("Error in execute:", error);
      throw error; // Re-throw the error to prevent further execution
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    try {
      const amount = actionParams[0];
      const userAddress = actor.account.address;

      const prevDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
      const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

      const prevStakesMapping = prevDFIREStakingSnapshot.stakesMapping || {};
      const newStakesMapping = newDFIREStakingSnapshot.stakesMapping || {};

      const prevTotalStake = prevDFIREStakingSnapshot.totalStake;
      const newTotalStake = newDFIREStakingSnapshot.totalStake;

      const newRewardSnapshot = newDFIREStakingSnapshot.totalRewardPerToken;
      const newCollateralSnapshot = newDFIREStakingSnapshot.totalCollateralPerToken;

      let prevUserStake = BigInt(0);
      if (prevStakesMapping[userAddress]) {
        prevUserStake = prevStakesMapping[userAddress].stake;
      }

      let newUserStake = BigInt(0);
      if (newStakesMapping[userAddress]) {
        newUserStake = newStakesMapping[userAddress].stake;
      }

      // Staking Balance Updates
      expect(newUserStake, "User stake should be decreased by amount").to.equal(prevUserStake - amount);
      expect(newTotalStake, "Total stake should be decreased by amount").to.equal(prevTotalStake - amount);

      // Reward Snapshot Updates
      if (newStakesMapping[userAddress]) {
        expect(newStakesMapping[userAddress].rewardSnapshot, "User reward snapshot should be updated").to.equal(newRewardSnapshot);
        expect(newStakesMapping[userAddress].collateralSnapshot, "User collateral snapshot should be updated").to.equal(newCollateralSnapshot);
      }

      // Token Transfer - DFIREToken Balance check for user
      const prevDfireTokenBalances = previousSnapshot.contractSnapshot.dfireToken.balances || {};
      const newDfireTokenBalances = newSnapshot.contractSnapshot.dfireToken.balances || {};

      const prevDfireTokenBalance = prevDfireTokenBalances[userAddress] || BigInt(0);
      const newDfireTokenBalance = newDfireTokenBalances[userAddress] || BigInt(0);


      expect(newDfireTokenBalance, "User's DFIREToken balance should increase by amount").to.equal(prevDfireTokenBalance + amount);

      // Token Transfer - DFIREToken Balance check for contract
      const prevContractDfireTokenBalances = previousSnapshot.contractSnapshot.dfireToken.balances || {};
      const newContractDfireTokenBalances = newSnapshot.contractSnapshot.dfireToken.balances || {};

      const prevContractDfireTokenBalance = prevContractDfireTokenBalances[this.contract.target] || BigInt(0);
      const newContractDfireTokenBalance = newContractDfireTokenBalances[this.contract.target] || BigInt(0);

      expect(newContractDfireTokenBalance, "Contract's DFIREToken balance should decrease by amount").to.equal(prevContractDfireTokenBalance - amount);

      // Validate RewardSender Flag Update (Conditional State Change)
      if (prevDFIREStakingSnapshot.rewardSenderActive && newTotalStake === BigInt(0)) {\n          // Assuming you have access to stableBaseCDP contract instance
          const stableBaseCDP = context.contracts.stableBaseCDP;
          expect(stableBaseCDP.sbrStakingPoolCanReceiveRewards, "IRewardSender.canSBRStakingPoolReceiveRewards should be false").to.be.false;
      }

      console.log("Validate: Unstake action validated successfully.");
      return true;
    } catch (error) {
      console.error("Error in validate:", error);
      return false;
    }
  }
}
