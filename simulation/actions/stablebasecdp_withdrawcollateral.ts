import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Account, Action } from "@svylabs/ilumia";
import { expect } from "chai";

import { StableBaseCDP, OrderedDoublyLinkedList, MockPriceOracle } from "./types";
import { Safe, StableBaseCDPSnapshot } from "./types/generated";

export class WithdrawCollateralAction extends Action {
  private contract: StableBaseCDP;

  constructor(contract: ethers.Contract) {
    super("WithdrawCollateralAction");
    // Correctly assert the type of the contract
    this.contract = contract as StableBaseCDP;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const stableBaseCDPSnapshot: StableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    // Select a safeId that exists in the safes mapping
    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);
    if (safeIds.length === 0) {
      throw new Error("No safes available to withdraw collateral from.");
    }
    const safeId = safeIds[context.prng.next() % safeIds.length];

    const safe: Safe = stableBaseCDPSnapshot.safes[safeId];

    // Ensure there is collateral to withdraw
    if (safe.collateralAmount <= BigInt(0)) {
      throw new Error(`Safe ${safeId} has no collateral to withdraw.`);
    }

    // Generate a random amount to withdraw, but ensure it's within the safe's collateral amount
    let amount: bigint;
    if (safe.collateralAmount > BigInt(0)) {
        amount = BigInt(context.prng.next()) % safe.collateralAmount + BigInt(1);
    } else {
        throw new Error("Safe has no collateral to withdraw.");
    }

    // Nearest spot in liquidation queue (can be zero if unknown/doesn't matter)
    const nearestSpotInLiquidationQueue = BigInt(context.prng.next());

    const params = [
      BigInt(safeId),
      amount,
      nearestSpotInLiquidationQueue,
    ];

    return [params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [safeId, amount, nearestSpotInLiquidationQueue] = actionParams;
    // Correctly assert the type and connect the actor's signer
    return this.contract
      .connect(actor.account.value as ethers.Signer)
      .withdrawCollateral(
        safeId,
        amount,
        nearestSpotInLiquidationQueue
      );
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const [safeId, amount, _] = actionParams;

    const previousStableBaseCDPSnapshot: StableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot: StableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe: Safe = previousStableBaseCDPSnapshot.safes[safeId];
    const newSafe: Safe = newStableBaseCDPSnapshot.safes[safeId];

    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;

    // Safe State and Collateral Validation
    expect(newSafe.collateralAmount).to.equal(previousSafe.collateralAmount - amount, "Safe's collateralAmount should be decreased by amount.");

    // Total Collateral Validation
    expect(newTotalCollateral).to.equal(previousTotalCollateral - amount, "totalCollateral should be decreased by amount.");

    // Account balance validation: Verify that the actor's ETH balance increased by the withdrawn amount
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    expect(newAccountBalance - previousAccountBalance).to.equal(amount, "Account balance should increase by the withdrawn amount.");

    // Comprehensive validation for all affected state variables based on action details

     // Add state change validations here

    return true;
  }
}
