import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class BorrowAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("BorrowAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    // Find a safe owned by the actor
    let safeId: number | undefined;
    for (const id in stableBaseCDPSnapshot.safes) {
        if (stableBaseCDPSnapshot.safeOwners[Number(id)] === actor.account.address) {
            safeId = Number(id);
            break;
        }
    }

    if (safeId === undefined) {
      return [false, {}, {}];
    }

    const safe = stableBaseCDPSnapshot.safes[safeId];

    if (!safe) {
      return [false, {}, {}];
    }

    const priceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
    const price = priceOracleSnapshot.price;

    const liquidationRatio = BigInt(20000); // Assuming 200% liquidation ratio
    const BASIS_POINTS_DIVISOR = BigInt(10000);
    const PRECISION = BigInt(1000000000000);
    const MINIMUM_DEBT = stableBaseCDPSnapshot.minimumDebt;

    const maxBorrowAmount = ((
      (safe.collateralAmount * price * BASIS_POINTS_DIVISOR)
    ) / liquidationRatio) / PRECISION;

    let amount = BigInt(context.prng.next()) % (maxBorrowAmount - safe.borrowedAmount);
    if (amount <= BigInt(0)) {
        amount = BigInt(10);
    }
    if (safe.borrowedAmount + amount < MINIMUM_DEBT) {
        amount = MINIMUM_DEBT - safe.borrowedAmount
    }

    const shieldingRate = BigInt(context.prng.next()) % BASIS_POINTS_DIVISOR;
    const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const safesOrderedForRedemptionSnapshot = currentSnapshot.contractSnapshot.safesOrderedForRedemption;

    const liquidationQueueSafeIds = Object.keys(safesOrderedForLiquidationSnapshot.nodes).map(Number);
    const redemptionQueueSafeIds = Object.keys(safesOrderedForRedemptionSnapshot.nodes).map(Number);

    let nearestSpotInLiquidationQueue = BigInt(0);
    if (liquidationQueueSafeIds.length > 0) {
        nearestSpotInLiquidationQueue = BigInt(liquidationQueueSafeIds[context.prng.next() % liquidationQueueSafeIds.length]);
    }

    let nearestSpotInRedemptionQueue = BigInt(0);
    if (redemptionQueueSafeIds.length > 0) {
        nearestSpotInRedemptionQueue = BigInt(redemptionQueueSafeIds[context.prng.next() % redemptionQueueSafeIds.length]);
    }

    const canExecute = safe.borrowedAmount + amount <= maxBorrowAmount && safe.borrowedAmount + amount >= MINIMUM_DEBT && amount > BigInt(0);
    const actionParams = canExecute
      ? {
          safeId: BigInt(safeId),
          amount: BigInt(amount),
          shieldingRate: BigInt(shieldingRate),
          nearestSpotInLiquidationQueue: BigInt(nearestSpotInLiquidationQueue),
          nearestSpotInRedemptionQueue: BigInt(nearestSpotInRedemptionQueue),
        }
      : {};

    return [canExecute, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract
      .connect(actor.account.value)
      .borrow(
        actionParams.safeId,
        actionParams.amount,
        actionParams.shieldingRate,
        actionParams.nearestSpotInLiquidationQueue,
        actionParams.nearestSpotInRedemptionQueue
      );
    return { receipt: await tx.wait(), events: [] };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const safesOrderedForLiquidationPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const safesOrderedForLiquidationNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const safesOrderedForRedemptionPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;

    const safeId = Number(actionParams.safeId);
    const amount = actionParams.amount;
    const shieldingRate = actionParams.shieldingRate;

    const safePrevious = stableBaseCDPPrevious.safes[safeId];
    const safeNew = stableBaseCDPNew.safes[safeId];

    const BASIS_POINTS_DIVISOR = BigInt(10000);
    const _shieldingFee = (amount * shieldingRate) / BASIS_POINTS_DIVISOR;
    const _amountToBorrow = amount - _shieldingFee;

    // Safe validations
    expect(safeNew.borrowedAmount).to.equal(safePrevious.borrowedAmount + amount, "safe.borrowedAmount should be increased by amount.");
    expect(safeNew.totalBorrowedAmount).to.equal(safePrevious.totalBorrowedAmount + amount, "safe.totalBorrowedAmount should be increased by amount.");
    expect(safeNew.feePaid).to.equal(safePrevious.feePaid + _shieldingFee, "safe.feePaid should be increased by _shieldingFee.");

    //SBD Token Validations
    expect(dfidTokenNew.balances[actor.account.address]).to.equal(dfidTokenPrevious.balances[actor.account.address] + BigInt(_amountToBorrow), "Borrower's SBD balance should be increased by the borrow amount (less fees, plus refunds, if any)");

    // Total Debt validation
    expect(stableBaseCDPNew.totalDebt).to.equal(stableBaseCDPPrevious.totalDebt + amount, "totalDebt should be increased by the borrowed amount.");

    //Liquidation Queue Validation
    const ratioNew = (safeNew.borrowedAmount * BigInt(1000000000000)) / safeNew.collateralAmount; //PRECISION
    if (safesOrderedForLiquidationNew.nodes[safeId]) {
        expect(safesOrderedForLiquidationNew.nodes[safeId].value).to.equal(ratioNew, "Liquidation queue should contain the safeId with the correct borrowAmount per unit collateral ratio");
    } else {
        expect(safesOrderedForLiquidationPrevious.nodes[safeId]).to.be.undefined;
    }

    //Redemption Queue Validation
     if (safesOrderedForRedemptionNew.nodes[safeId]) {
        expect(safesOrderedForRedemptionNew.nodes[safeId].value).to.equal(safeNew.weight, "Redemption queue should contain safeId with the updated weight");
    } else {
        expect(safesOrderedForRedemptionPrevious.nodes[safeId]).to.be.undefined;
    }

    //Liquidation Snapshot Validation
    if (stableBaseCDPPrevious.liquidationSnapshots[safeId].collateralPerCollateralSnapshot != stableBaseCDPNew.cumulativeCollateralPerUnitCollateral) {
        expect(stableBaseCDPNew.liquidationSnapshots[safeId].debtPerCollateralSnapshot).to.equal(stableBaseCDPNew.cumulativeDebtPerUnitCollateral, "debtPerCollateralSnapshot should be updated");
        expect(stableBaseCDPNew.liquidationSnapshots[safeId].collateralPerCollateralSnapshot).to.equal(stableBaseCDPNew.cumulativeCollateralPerUnitCollateral, "collateralPerCollateralSnapshot should be updated");
    }


    return true;
  }
}
