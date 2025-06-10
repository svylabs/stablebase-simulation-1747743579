import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class AddCollateralAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("AddCollateralAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot: any = currentSnapshot.contractSnapshot.stableBaseCDP; // added any to avoid ts error
    // Ensure safeId exists within the safes mapping.
    let safeId: bigint;
    if (stableBaseCDPSnapshot.safes && Object.keys(stableBaseCDPSnapshot.safes).length > 0) {
        const safeIds = Object.keys(stableBaseCDPSnapshot.safes);
        safeId = BigInt(safeIds[context.prng.next() % safeIds.length]);
    } else {
        // If no safes exist, return early.
        return [false, {}, {}];
    }

    // Amount should be a reasonable value based on account balance
    const accountBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const amount = BigInt(context.prng.next()) % (accountBalance > BigInt(1000) ? BigInt(1000) : accountBalance) + BigInt(1);

    // nearestSpotInLiquidationQueue - a random value for testing purposes.
    const nearestSpotInLiquidationQueue = BigInt(context.prng.next()) % BigInt(100);

    if (accountBalance < amount) {
      return [false, {}, {}];
    }

    const parameters = {
      safeId: safeId,
      amount: amount,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
    };

    return [true, parameters, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .addCollateral(safeId, amount, nearestSpotInLiquidationQueue, { value: amount });

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
    const { safeId, amount } = actionParams;
    const stableBaseCDPPrevious: any = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew: any = newSnapshot.contractSnapshot.stableBaseCDP;

    const safesOrderedForLiquidationPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const safesOrderedForLiquidationNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    // Safe State Validation
    const previousSafe = stableBaseCDPPrevious.safes ? stableBaseCDPPrevious.safes[safeId.toString()] : undefined;
    const newSafe = stableBaseCDPNew.safes ? stableBaseCDPNew.safes[safeId.toString()] : undefined;

    if (!previousSafe || !newSafe) {
        console.warn("Safe information not found in snapshots for safeId:", safeId.toString());
        return false;  // Or throw an error, depending on your validation needs
    }

    expect(newSafe.collateralAmount).to.equal(previousSafe.collateralAmount + amount, "safes[safeId].collateralAmount should be increased by amount.");

    // Total State Validation
    expect(stableBaseCDPNew.totalCollateral).to.equal(stableBaseCDPPrevious.totalCollateral + amount, "totalCollateral should be increased by the amount added.");

    // Account Balance Validation
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    expect(newAccountBalance).to.equal(previousAccountBalance - amount, "Account balance should be decreased by amount.");


    //Liquidation Queue state validation

    return true;
  }
}
