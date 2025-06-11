import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class RedeemAction extends Action {
  private contract: ethers.Contract;
  private dfidTokenAddress: string;
  private stabilityPoolAddress: string;

  constructor(
    contract: ethers.Contract,
    dfidTokenAddress: string,
    stabilityPoolAddress: string
  ) {
    super("RedeemAction");
    this.contract = contract;
    this.dfidTokenAddress = dfidTokenAddress;
    this.stabilityPoolAddress = stabilityPoolAddress;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;

    if (!stableBaseCDPSnapshot || !dfidTokenSnapshot) {
      console.warn("Missing snapshots, cannot proceed with Redeem action");
      return [false, {}, {}];
    }

    const actorAddress = actor.account.address;
    const actorSBDBalance = dfidTokenSnapshot.balances[actorAddress] || BigInt(0);

    if (actorSBDBalance <= BigInt(0)) {
      console.warn("Actor has insufficient SBD balance to redeem.");
      return [false, {}, {}];
    }

    // Initialize amount within the bounds of the actor's SBD balance
    const amount = BigInt(Math.floor(context.prng.next() % Number(actorSBDBalance) + 1));
    const nearestSpotInLiquidationQueue = BigInt(0);

    const canExecute = amount > BigInt(0);

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
  ): Promise<ExecutionReceipt> {
    const { amount, nearestSpotInLiquidationQueue } = actionParams;

    // Use the contract passed in the constructor to call the redeem function
    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .redeem(amount, nearestSpotInLiquidationQueue);

    const receipt = await tx.wait();

    return { receipt: receipt, rawResponse: tx };
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

    if (!executionReceipt.receipt) {
      console.error("Execution receipt is missing, validation cannot proceed.");
      return false;
    }

    if (!stableBaseCDPPrevious || !stableBaseCDPNew || !dfidTokenPrevious || !dfidTokenNew) {
      console.warn("Missing CDP or Token snapshots, cannot validate Redeem action");
      return false;
    }

    const actorAddress = actor.account.address;
    const previousActorSBDBalance = dfidTokenPrevious.balances[actorAddress] || BigInt(0);
    const newActorSBDBalance = dfidTokenNew.balances[actorAddress] || BigInt(0);

    const previousTotalCollateral = stableBaseCDPPrevious.totalCollateral;
    const newTotalCollateral = stableBaseCDPNew.totalCollateral;
    const previousTotalDebt = stableBaseCDPPrevious.totalDebt;
    const newTotalDebt = stableBaseCDPNew.totalDebt;
    const previousTotalSupply = dfidTokenPrevious.totalSupply;
    const newTotalSupply = dfidTokenNew.totalSupply;
    const previousTotalBurned = dfidTokenPrevious.totalBurned;
    const newTotalBurned = dfidTokenNew.totalBurned;
    const previousProtocolMode = stableBaseCDPPrevious.protocolMode;
    const newProtocolMode = stableBaseCDPNew.protocolMode;

    const previousAccountETHBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    const newAccountETHBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    const contractAddress = this.contract.target;

    // Validating balances and state changes
    expect(newActorSBDBalance).to.be.lte(previousActorSBDBalance, "Actor SBD balance should decrease or remain same");
    expect(newTotalCollateral).to.be.lte(previousTotalCollateral, "Total collateral should decrease or remain same");
    expect(newTotalDebt).to.be.lte(previousTotalDebt, "Total debt should decrease or remain same");
    expect(newTotalSupply).to.be.lt(previousTotalSupply, "Total supply should decrease");
    expect(newTotalBurned).to.be.gt(previousTotalBurned, "Total burned should increase");
    expect(newProtocolMode).to.be.gte(previousProtocolMode, "Protocol mode should stay the same or increase");

    // Check ETH balance change - should increase due to collateral received
    expect(newAccountETHBalance).to.be.gte(previousAccountETHBalance, "Actor ETH balance should increase or remain same");

    // Event validation
    const events = executionReceipt.receipt.logs.map((log) =>
      this.contract.interface.parseLog(log)
    );
    const redeemedBatchEvent = events.find((e) => e?.name === "RedeemedBatch");
    expect(redeemedBatchEvent, "RedeemedBatch event should be emitted").to.not
      .be.undefined;

    // Additional checks based on the state updates

    return true;
  }
}
