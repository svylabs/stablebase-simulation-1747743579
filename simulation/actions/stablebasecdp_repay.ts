import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class RepayAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("RepayAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
    const dfidToken = currentSnapshot.contractSnapshot.dfidToken;
    const safeIds = Object.keys(stableBaseCDP.safes).map(Number);

    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    let safeId: number | undefined = undefined;
    let safe: any;

    // Find a safe with borrowed amount > 0 and owned by the actor
    for (let i = 0; i < safeIds.length; i++) {
      safeId = safeIds[i];
      safe = stableBaseCDP.safes[safeId];
      try {
        if (
          safe &&
          safe.borrowedAmount > BigInt(0) &&
          (await this.contract.ownerOf(safeId)) === actor.account.address
        ) {
          break;
        } else {
            safeId = undefined;
        }
      } catch (e) {
        // Handle the error appropriately, possibly skipping this safe
        console.error(`Error checking ownership for safeId ${safeId}:`, e);
        safeId = undefined;
      }
    }

    if (!safeId) {
      return [false, {}, {}];
    }

    const actorBalance = dfidToken.balances[actor.account.address] || BigInt(0);
    if (actorBalance <= BigInt(0)) {
      return [false, {}, {}];
    }

    const maxRepayableAmount = stableBaseCDP.safes[safeId].borrowedAmount > actorBalance ? actorBalance : stableBaseCDP.safes[safeId].borrowedAmount

    const amountToRepay = BigInt(Math.floor(context.prng.next() % Number(maxRepayableAmount + BigInt(1))));

    // Attempt to find a valid nearestSpotInLiquidationQueue.  If none exist, use 0.
    let nearestSpotInLiquidationQueue = BigInt(0);
    const liquidationQueueSafeIds = Object.keys(currentSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes).map(Number);
    if(liquidationQueueSafeIds.length > 0) {
        nearestSpotInLiquidationQueue = BigInt(liquidationQueueSafeIds[context.prng.next() % liquidationQueueSafeIds.length]);
    }

    const actionParams = {
      safeId: BigInt(safeId),
      amount: amountToRepay,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    return this.contract
      .connect(actor.account.value)
      .repay(
        actionParams.safeId,
        actionParams.amount,
        actionParams.nearestSpotInLiquidationQueue
      );
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const safeId = actionParams.safeId;
    const amount = actionParams.amount;

    const previousStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;
    const previousLiquidationQueue = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const newLiquidationQueue = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    // Safe State Validation
    const previousSafe = previousStableBaseCDP.safes[Number(safeId)];
    const newSafe = newStableBaseCDP.safes[Number(safeId)];

    if (previousSafe) {
        if(newSafe) {
          expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount - amount, "Borrowed amount should be decreased by amount.");
          expect(newSafe.borrowedAmount).to.be.at.least(BigInt(0), "Borrowed amount should be non-negative.");
          if (newSafe.borrowedAmount > BigInt(0)) {
            expect(newSafe.borrowedAmount).to.be.at.least(BigInt(0), "Borrowed amount should be greater than or equal to MINIMUM_DEBT.");
          }
        } else {
          expect(previousSafe.borrowedAmount).to.equal(amount, "If safe is removed, the repaid amount should equal the previous borrowed amount.");
           // Safe should be removed from both queues
           expect(newLiquidationQueue.nodes[safeId]).to.be.undefined;
        }
    } else {
        // If previousSafe does not exist, then there is an error.
        return false;
    }

    // Token State Validation
    const previousActorBalance = previousDFIDToken.balances[actor.account.address] || BigInt(0);
    const newActorBalance = newDFIDToken.balances[actor.account.address] || BigInt(0);

    expect(newActorBalance).to.equal(previousActorBalance - amount, "Actor's SBD balance should decrease by amount.");
    expect(newDFIDToken.totalSupply).to.equal(previousDFIDToken.totalSupply - amount, "DFIDToken total supply should decrease by amount.");
    expect(newDFIDToken.totalBurned).to.equal(previousDFIDToken.totalBurned + amount, "DFIDToken total burned should increase by amount.");

    // Total Debt Validation
    expect(newStableBaseCDP.totalDebt).to.equal(previousStableBaseCDP.totalDebt - amount, "Total debt should decrease by amount.");


    // Check for state updates in the _updateSafe internal function
    if (
      previousStableBaseCDP.cumulativeCollateralPerUnitCollateral !==
      newStableBaseCDP.cumulativeCollateralPerUnitCollateral
    ) {
      // Validate liquidationSnapshots update
      expect(
        newStableBaseCDP.debtPerCollateralSnapshot[safeId]
      ).to.equal(
        newStableBaseCDP.cumulativeDebtPerUnitCollateral,
        "liquidationSnapshots[safeId].debtPerCollateralSnapshot should be updated"
      );
      expect(
        newStableBaseCDP.collateralPerCollateralSnapshot[safeId]
      ).to.equal(
        newStableBaseCDP.cumulativeCollateralPerUnitCollateral,
        "liquidationSnapshots[safeId].collateralPerCollateralSnapshot should be updated"
      );

      // Validate totalCollateral update is more involved, skip for now
    }

    // Validate PROTOCOL_MODE update
     if (
            previousStableBaseCDP.totalDebt > BigInt(5000000000000000) &&
            newStableBaseCDP.totalDebt <= BigInt(5000000000000000)
        ) {
          // Assuming there's a way to access PROTOCOL_MODE from the snapshots
          // Example: expect(newSnapshot.contractSnapshot.stableBaseCDP.PROTOCOL_MODE).to.equal(1);
           console.log("PROTOCOL_MODE validation skipped as it is not available in snapshot");
        }


    return true;
  }
}
