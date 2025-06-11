import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class RepayAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("RepayAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;

    const safeIds = stableBaseCDPSnapshot.safes ? Object.keys(stableBaseCDPSnapshot.safes) : [];
    if (safeIds.length === 0) {
      return [false, [], {}];
    }

    let safeId: bigint | null = null;
    for (const id of safeIds) {
      const safeInfo = stableBaseCDPSnapshot.safes ? stableBaseCDPSnapshot.safes[BigInt(id)] : undefined;
      if (safeInfo && safeInfo.borrowedAmount > BigInt(0)) {
        safeId = BigInt(id);
        break;
      }
    }

    if (!safeId) {
      return [false, [], {}];
    }

    const safeInfo = stableBaseCDPSnapshot.safes ? stableBaseCDPSnapshot.safes[safeId] : undefined;
    if (!safeInfo) {
      return [false, [], {}];
    }

    const borrowedAmount = safeInfo.borrowedAmount;

    const actorBalance = dfidTokenSnapshot.balances[actor.account.address] || BigInt(0);

    if (borrowedAmount <= BigInt(0) || actorBalance <= BigInt(0)) {
      return [false, [], {}];
    }

    let amount: bigint;
    if (actorBalance < borrowedAmount) {
      amount = BigInt(context.prng.next()) % actorBalance + BigInt(1);
    } else {
      amount = BigInt(context.prng.next()) % borrowedAmount + BigInt(1);
    }

    const nearestSpotInLiquidationQueue = BigInt(0);

    const params = [
      safeId,
      amount,
      nearestSpotInLiquidationQueue,
    ];

    return [true, params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const [safeId, amount, nearestSpotInLiquidationQueue] = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .repay(safeId, amount, nearestSpotInLiquidationQueue);

    return { receipt: await tx.wait(), additionalInfo: {} };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const [safeId, amount, nearestSpotInLiquidationQueue] = actionParams;

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const previousAccountSnapshot = previousSnapshot.accountSnapshot;
    const newAccountSnapshot = newSnapshot.accountSnapshot;

    // Safe State Validations
    const previousSafeInfo = previousStableBaseCDPSnapshot.safes![safeId];
    const newSafeInfo = newStableBaseCDPSnapshot.safes![safeId];

    expect(newSafeInfo.borrowedAmount).to.be.lte(previousSafeInfo.borrowedAmount, "borrowedAmount should be decreased by amount.");

    if (newSafeInfo.borrowedAmount > BigInt(0)) {
      expect(newSafeInfo.borrowedAmount).to.be.gte(previousStableBaseCDPSnapshot.minimumDebt, "borrowedAmount should be greater than or equal to MINIMUM_DEBT.");
    } else {
      const safesOrderedForLiquidationSnapshotPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
      const safesOrderedForLiquidationSnapshotNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
      if (safesOrderedForLiquidationSnapshotNew.nodes && safesOrderedForLiquidationSnapshotNew.nodes[safeId]) {
        expect(safesOrderedForLiquidationSnapshotNew.nodes[safeId].value).to.be.eq(BigInt(0), "Safe should be removed from liquidation queue");
      }

      const safesOrderedForRedemptionSnapshotPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
      const safesOrderedForRedemptionSnapshotNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;

      if (safesOrderedForRedemptionSnapshotNew.nodes && safesOrderedForRedemptionSnapshotNew.nodes[safeId]) {
        expect(safesOrderedForRedemptionSnapshotNew.nodes[safeId].value).to.be.eq(BigInt(0), "Safe should be removed from redemption queue");
      }
    }
    // Token State Validations
    const previousActorBalance = previousDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);
    const newActorBalance = newDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);

    expect(newActorBalance).to.be.eq(previousActorBalance - amount, "The SBD token balance of the user (msg.sender) should be decreased by the amount repaid.");

    const previousTotalSupply = previousDFIDTokenSnapshot.totalSupply;
    const newTotalSupply = newDFIDTokenSnapshot.totalSupply;

    expect(newTotalSupply).to.be.eq(previousTotalSupply - amount, "The total supply of SBD tokens should be decreased by the amount repaid.");

    // Total Debt Validations
    expect(newStableBaseCDPSnapshot.totalDebt).to.be.eq(previousStableBaseCDPSnapshot.totalDebt - amount, "totalDebt should be decreased by amount.");

    // Protocol Mode Validation
    if (
      previousStableBaseCDPSnapshot.totalDebt > previousStableBaseCDPSnapshot.bootstrapModeDebtThreshold &&
      previousStableBaseCDPSnapshot.mode == 0
    ) {
      if (newStableBaseCDPSnapshot.totalDebt < previousStableBaseCDPSnapshot.bootstrapModeDebtThreshold) {
        expect(newStableBaseCDPSnapshot.mode).to.be.eq(1, "PROTOCOL_MODE should be NORMAL.");
      }
    }

    // Event Emission Validation
    const repaidEvent = executionReceipt.receipt.logs.find(
      (log) => log.address === this.contract.target && this.contract.interface.parseLog(log)?.name === "Repaid"
    );

    expect(repaidEvent).to.not.be.undefined;

    return true;
  }
}
