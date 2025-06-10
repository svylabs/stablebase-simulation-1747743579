import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class RedeemAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("RedeemAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
    const dfidToken = currentSnapshot.contractSnapshot.dfidToken;

    const accountBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const sbdTokenBalance = (dfidToken.balances && dfidToken.balances[actor.account.address]) || BigInt(0);

    if (sbdTokenBalance <= BigInt(0)) {
      console.log("RedeemAction: Insufficient SBD balance.");
      return [false, {}, {}];
    }

    // Generate a random amount within the available SBD token balance
    const amount = BigInt(Math.floor(context.prng.next() % Number(sbdTokenBalance) + 1));
    // Generate a random value for nearestSpotInLiquidationQueue
    const nearestSpotInLiquidationQueue = BigInt(Math.floor(context.prng.next() % 100)); // Assuming a reasonable upper bound for the queue spot

    console.log(`RedeemAction: amount = ${amount}, nearestSpotInLiquidationQueue = ${nearestSpotInLiquidationQueue}`);

    const canExecute = amount > BigInt(0) && sbdTokenBalance >= amount;

    const actionParams = {
      amount: amount,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
    };

    return [canExecute, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { amount, nearestSpotInLiquidationQueue } = actionParams;

    // Approve the contract to spend the SBD tokens
    const dfidTokenContract = new ethers.Contract(
      (context.contracts.dfidToken as any).target,
      (context.contracts.dfidToken as any).interface,
      actor.account.value
    );

    const stableBaseCDPAddress = (context.contracts.stableBaseCDP as any).target;
    const approveTx = await dfidTokenContract.approve(stableBaseCDPAddress, amount);
    await approveTx.wait();

    // Execute the redeem action
    const tx = await this.contract
      .connect(actor.account.value)
      .redeem(amount, nearestSpotInLiquidationQueue);
    await tx.wait();

    console.log("RedeemAction: redeem transaction executed.");
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { amount, nearestSpotInLiquidationQueue } = actionParams;
    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const contractAddress = (context.contracts.stableBaseCDP as any).target;
    const redeemerAddress = actor.account.address;
    const sbdTokenContractAddress = (context.contracts.dfidToken as any).target;

    // Validate SBD token balance of the contract
    const previousContractSBDTokenBalance = (dfidTokenPrevious.balances && dfidTokenPrevious.balances[contractAddress]) || BigInt(0);
    const newContractSBDTokenBalance = (dfidTokenNew.balances && dfidTokenNew.balances[contractAddress]) || BigInt(0);

    // Validate the redeemer's SBD token balance
    const previousRedeemerSBDTokenBalance = (dfidTokenPrevious.balances && dfidTokenPrevious.balances[redeemerAddress]) || BigInt(0);
    const newRedeemerSBDTokenBalance = (dfidTokenNew.balances && dfidTokenNew.balances[redeemerAddress]) || BigInt(0);

    // Validate the redeemer's SBD token balance decreased by the amount redeemed
    expect(newRedeemerSBDTokenBalance).to.equal(previousRedeemerSBDTokenBalance - amount, "Redeemer's SBD balance should decrease by the amount being redeemed");

    // Assuming the contract burns the tokens, validate the contract's SBD balance remains the same because the contract received and burned.
    expect(newContractSBDTokenBalance).to.equal(previousContractSBDTokenBalance, "Contract's SBD balance should remain the same");

    // Validate total debt decreased
    expect(stableBaseCDPNew.totalDebt).to.lte(stableBaseCDPPrevious.totalDebt, "Total debt should decrease");

    // Validate total collateral decreased
    expect(stableBaseCDPNew.totalCollateral).to.lte(stableBaseCDPPrevious.totalCollateral, "Total collateral should decrease");

    // Additional validations based on state changes (example - more details will be needed based on which safes are being redeemed):
    // Example: Validate safe state (if applicable, removal from queues, liquidation ratio updates)
    // Example: Validate fee distribution
    // Example: Validate stability pool updates

    console.log("RedeemAction: validation successful.");
    return true;
  }
}
