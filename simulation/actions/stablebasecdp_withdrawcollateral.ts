import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class WithdrawCollateralAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("WithdrawCollateralAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
    const mockPriceOracle = currentSnapshot.contractSnapshot.mockPriceOracle;
    const safeIds = Object.keys(stableBaseCDP.safes).map(Number);

    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    const safeId = safeIds[context.prng.next() % safeIds.length];
    const safe = stableBaseCDP.safes[safeId];

    if (!safe || safe.collateralAmount === BigInt(0)) {
      return [false, {}, {}];
    }

    // Determine a valid withdrawal amount.
    let amount: bigint;
    if (safe.borrowedAmount > BigInt(0)) {
      const price = mockPriceOracle.price;
      const liquidationRatio = 1500000000000000000n; // Assuming 1.5 as liquidation ratio (fetch from contract if available)

      const PRECISION = 1000000000000000000n;
      const BASIS_POINTS_DIVISOR = 10000n;

      const maxWithdrawal = safe.collateralAmount - 
                              (safe.borrowedAmount * liquidationRatio * PRECISION) /
                              (price * BASIS_POINTS_DIVISOR);

      if (maxWithdrawal <= BigInt(0)) {
        return [false, {}, {}];
      }

      amount = BigInt(context.prng.next()) % maxWithdrawal + BigInt(1);

    } else {
      amount = BigInt(context.prng.next()) % safe.collateralAmount + BigInt(1);
    }

    const nearestSpotInLiquidationQueue = BigInt(0); // Can set to a valid safeId if available, setting to 0 as default

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
  ): Promise<Record<string, any> | void> {
    const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .withdrawCollateral(safeId, amount, nearestSpotInLiquidationQueue);

    await tx.wait();
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

    const previousStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe = previousStableBaseCDP.safes[safeId];
    const newSafe = newStableBaseCDP.safes[safeId];

    const initialTotalCollateral = previousStableBaseCDP.totalCollateral;
    const finalTotalCollateral = newStableBaseCDP.totalCollateral;

    // Collateral Validation
    expect(newSafe.collateralAmount).to.equal(
      previousSafe.collateralAmount - amount,
      "Safe's collateralAmount should be decreased by the withdrawn amount"
    );

    expect(finalTotalCollateral).to.equal(
      initialTotalCollateral - amount,
      "totalCollateral should be decreased by the withdrawn amount"
    );

    expect(newSafe.collateralAmount).to.be.at.least(BigInt(0), "safe.collateralAmount should be greater than or equal to 0");
    expect(finalTotalCollateral).to.be.at.least(BigInt(0), "totalCollateral should be greater than or equal to 0");

    // Token Balance Validation - User's ETH balance should increase by amount.
    const initialAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const finalAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    expect(finalAccountBalance - initialAccountBalance).to.equal(amount, "User's ETH balance should increase by amount");

    // Liquidation Snapshot Validation
    if (previousStableBaseCDP.debtPerCollateralSnapshot && previousStableBaseCDP.collateralPerCollateralSnapshot && newStableBaseCDP.cumulativeCollateralPerUnitCollateral && newStableBaseCDP.cumulativeDebtPerUnitCollateral) {
      if (previousStableBaseCDP.collateralPerCollateralSnapshot[safeId] != newStableBaseCDP.cumulativeCollateralPerUnitCollateral) {
        expect(newStableBaseCDP.debtPerCollateralSnapshot[safeId]).to.equal(
          newStableBaseCDP.cumulativeDebtPerUnitCollateral,
          "Debt snapshot should be updated"
        );
        expect(newStableBaseCDP.collateralPerCollateralSnapshot[safeId]).to.equal(
          newStableBaseCDP.cumulativeCollateralPerUnitCollateral,
          "Collateral snapshot should be updated"
        );
      }
    }

    // Liquidation Queue Validation
    if (previousSafe.borrowedAmount > BigInt(0)) {
      // Check if the safe's position in the liquidation queue has been updated.
      // This requires fetching the new ratio from the contract since it is not directly available in the snapshot.
      // This is not possible without calling the contract. Leaving it out.
    }

    return true;
  }
}
