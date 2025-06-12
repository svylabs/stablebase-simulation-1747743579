import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class AddCollateralAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("AddCollateralAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    // Find a safe that exists and belongs to the actor
    let safeId: number | null = null;
    for (const id in stableBaseCDPSnapshot.safeOwners) {
      if (stableBaseCDPSnapshot.safeOwners[id] === actor.account.address) {
        safeId = parseInt(id, 10);
        break;
      }
    }

    if (safeId === null || !(safeId in stableBaseCDPSnapshot.safesData)) {
      console.log("No suitable safe found for the actor.");
      return [false, {}, {}];
    }

    const safe = stableBaseCDPSnapshot.safesData[safeId];

    if (safe.collateralAmount === BigInt(0)) {
      console.log("Safe has no collateral.");
      return [false, {}, {}];
    }

    // Generate a random amount of collateral to add, up to a reasonable limit
    const maxAmount = BigInt(100) * BigInt(10) ** BigInt(18);
    const amount = BigInt(context.prng.next()) % maxAmount + BigInt(1);

    // Suggest using 0 for simplicity, let the contract determine the nearest spot based on current ratios.
    const nearestSpotInLiquidationQueue = BigInt(0);

    // Ensure the actor has enough ETH to send as msg.value
    const actorBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    if (actorBalance < amount) {
      console.log("Actor does not have enough ETH to add collateral.");
      return [false, {}, {}];
    }

    const actionParams = {
      safeId: BigInt(safeId),
      amount: amount,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
      value: amount, // msg.value should be equal to the amount
    };

    console.log("Generated action params:", actionParams);

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract
      .connect(actor.account.value)
      .addCollateral(
        actionParams.safeId,
        actionParams.amount,
        actionParams.nearestSpotInLiquidationQueue,
        { value: actionParams.value }
      );

    const receipt = await tx.wait();

    return { receipt };
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

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe = previousStableBaseCDPSnapshot.safesData[Number(safeId)];
    const newSafe = newStableBaseCDPSnapshot.safesData[Number(safeId)];

    const initialTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;

    // Safe State validation
    expect(newSafe.collateralAmount).to.equal(
      previousSafe.collateralAmount + amount,
      "safes[safeId].collateralAmount should be equal to the initial collateralAmount plus the amount added."
    );

    // Global State validation
    expect(newTotalCollateral).to.equal(
      initialTotalCollateral + amount,
      "totalCollateral should be equal to the initial totalCollateral plus the amount added."
    );

    // Account Balance Validation
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    expect(newAccountBalance).to.equal(previousAccountBalance - amount, "Account balance should have decreased by the amount sent.");

    // Borrowed amount validation
    const cumulativeDebtPerUnitCollateralPrevious = previousStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral;
    const cumulativeDebtPerUnitCollateralNew = newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral;
    const liquidationSnapshotPrevious = previousStableBaseCDPSnapshot.liquidationSnapshotsData[Number(safeId)];
    const liquidationSnapshotNew = newStableBaseCDPSnapshot.liquidationSnapshotsData[Number(safeId)];

    if (liquidationSnapshotPrevious.collateralPerCollateralSnapshot !== previousStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral) {
      // Calculate expected debt increase
      const debtIncrease = (previousSafe.collateralAmount * (cumulativeDebtPerUnitCollateralPrevious - liquidationSnapshotPrevious.debtPerCollateralSnapshot)) / BigInt(10) ** BigInt(18);

      expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + debtIncrease, "Borrowed amount should be updated based on cumulativeDebtPerUnitCollateral.");
      expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + debtIncrease, "Total borrowed amount should be updated based on cumulativeDebtPerUnitCollateral");

      expect(liquidationSnapshotNew.debtPerCollateralSnapshot).to.equal(cumulativeDebtPerUnitCollateralNew, "liquidationSnapshots[safeId].debtPerCollateralSnapshot should be updated to cumulativeDebtPerUnitCollateral");
    }

    // Liquidation Queue Validation (Simplified - check head and tail if changed)
    const previousLiquidationQueueSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const newLiquidationQueueSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    const previousNode = previousLiquidationQueueSnapshot.nodes[Number(safeId)] || {prev: BigInt(0), next: BigInt(0)};
    const newNode = newLiquidationQueueSnapshot.nodes[Number(safeId)] || {prev: BigInt(0), next: BigInt(0)};

    expect(newNode.prev).to.equal(previousNode.prev, "Previous node in liquidation queue should be updated.");
    expect(newNode.next).to.equal(previousNode.next, "Next node in liquidation queue should be updated");

    // Check for protocol mode update if necessary
    const BOOTSTRAP_MODE_DEBT_THRESHOLD = previousStableBaseCDPSnapshot.BOOTSTRAP_MODE_DEBT_THRESHOLD;
    if (
      previousStableBaseCDPSnapshot.totalDebt <= BOOTSTRAP_MODE_DEBT_THRESHOLD &&
      newStableBaseCDPSnapshot.totalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD &&
      previousStableBaseCDPSnapshot.protocolMode === 0
    ) {
      expect(newStableBaseCDPSnapshot.protocolMode).to.equal(1, "PROTOCOL_MODE should be NORMAL");
    }

    return true;
  }
}
