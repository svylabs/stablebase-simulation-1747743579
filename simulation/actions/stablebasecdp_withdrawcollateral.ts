import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class WithdrawCollateralAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("WithdrawCollateralAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    if (!stableBaseCDPSnapshot) {
      return [false, {}, {}];
    }

    const safeIds = Object.keys(stableBaseCDPSnapshot.safes || {});
    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    let safeId: bigint | undefined;
    for (const id of safeIds) {
      const safe = stableBaseCDPSnapshot.safes?.[BigInt(id)];
      if (safe && safe.collateralAmount > BigInt(0)) {
        safeId = BigInt(id);
        break;
      }
    }

    if (!safeId) {
      return [false, {}, {}];
    }

    const safe = stableBaseCDPSnapshot.safes?.[safeId];

    if (!safe) {
      return [false, {}, {}];
    }

    let amount: bigint;
    const mockPriceOracle = context.contracts.mockPriceOracle;
    if (!mockPriceOracle) {
      console.warn("MockPriceOracle contract not found in context");
      return [false, {}, {}];
    }
    const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
    if (!mockPriceOracleSnapshot) {
      console.warn("MockPriceOracle snapshot not found");
      return [false, {}, {}];
    }
    const price = mockPriceOracleSnapshot.currentPrice;

    if (safe.borrowedAmount > BigInt(0)) {
      const liquidationRatio = 1500000000000000000n;
      const PRECISION = 1000000000000000000n;
      const BASIS_POINTS_DIVISOR = 10000n;
      const maxWithdrawal = safe.collateralAmount - (safe.borrowedAmount * liquidationRatio * PRECISION) / (price * BASIS_POINTS_DIVISOR);
      if (maxWithdrawal <= BigInt(0)) {
        return [false, {}, {}];
      }
      amount = context.prng.next() % (maxWithdrawal + BigInt(1));
      if (amount <= BigInt(0)) {
        amount = BigInt(1);
      }
    } else {
      amount = context.prng.next() % (safe.collateralAmount + BigInt(1));
      if (amount <= BigInt(0)) {
        amount = BigInt(1);
      }
    }

    const nearestSpotInLiquidationQueue = BigInt(0);

    const actionParams = {
      safeId: safeId,
      amount: amount,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;
    const tx = await this.contract
      .connect(actor.account.value)
      .withdrawCollateral(safeId, amount, nearestSpotInLiquidationQueue);

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
    const { safeId, amount } = actionParams;

    const previousSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes?.[safeId];
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes?.[safeId];

    const previousTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    const newTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;

    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    if (!previousSafe) {
      console.warn("Safe not found in previous snapshot");
      return false;
    }

    // Safe State Validation
    if (newSafe) {
      expect(newSafe.collateralAmount, 'safes[safeId].collateralAmount should be equal to the previous collateralAmount minus the amount withdrawn.')
        .to.equal(previousSafe.collateralAmount - amount);
    } else {
      // Safe should be removed if collateralAmount is zero after withdrawal
      expect(previousSafe.collateralAmount - amount, "Collateral should be zero").to.equal(BigInt(0));
    }

    // Total Collateral Validation
    expect(newTotalCollateral, 'totalCollateral should be equal to the previous totalCollateral minus the amount withdrawn.')
      .to.equal(previousTotalCollateral - amount);

    // Balance Validation
    expect(newAccountBalance, "The msg.sender's ETH balance should increase by the amount withdrawn.").to.equal(previousAccountBalance + amount);

    // borrowedAmount == 0 validation
    if (previousSafe.borrowedAmount <= BigInt(0)) {
      const liquidationHeadPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.head;
      const redemptionHeadPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption.head;

      const safesOrderedForLiquidationNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
      const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;

      // Check if safe was removed from liquidation queue
      if (liquidationHeadPrevious !== BigInt(0)) {
        if (safesOrderedForLiquidationNew && safesOrderedForLiquidationNew.nodes && safesOrderedForLiquidationNew.nodes[safeId]) {
          console.warn("Safe should be removed from liquidation queue");
          return false;
        }
      }

      // Check if safe was removed from redemption queue
      if (redemptionHeadPrevious !== BigInt(0)) {
        if (safesOrderedForRedemptionNew && safesOrderedForRedemptionNew.nodes && safesOrderedForRedemptionNew.nodes[safeId]) {
          console.warn("Safe should be removed from redemption queue");
          return false;
        }
      }
    }

    // Additional checks for total debt, cumulative values if needed

    return true;
  }
}
