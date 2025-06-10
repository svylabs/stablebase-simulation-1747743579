import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { expect } from "chai";
import { ethers } from "ethers";

export class LiquidateAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("LiquidateAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPContract = context.contracts.stableBaseCDP as ethers.Contract;
    const safesOrderedForLiquidationContract = context.contracts.safesOrderedForLiquidation as ethers.Contract;

    const tail = await safesOrderedForLiquidationContract.getTail();

    if (tail.toString() === "0") {
      console.log("safesOrderedForLiquidation is empty, cannot liquidate.");
      return [false, {}, {}];
    }

    const safeId = await safesOrderedForLiquidationContract.getTail();

    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    if (!stableBaseCDPSnapshot) {
      console.error("StableBaseCDP snapshot not found");
      return [false, {}, {}];
    }

    const safe = stableBaseCDPSnapshot.safes[Number(safeId)];

    if (!safe) {
      console.log(`Safe with ID ${safeId} does not exist, cannot liquidate.`);
      return [false, {}, {}];
    }

    const { collateralAmount, borrowedAmount } = safe;

    if (collateralAmount === BigInt(0) || borrowedAmount === BigInt(0)) {
      console.log(
        `Cannot liquidate Safe ${safeId} with no collateral or borrowed amount.`
      );
      return [false, {}, {}];
    }

    const mockPriceOracleContract = context.contracts.mockPriceOracle as ethers.Contract;
    const collateralPrice = await mockPriceOracleContract.fetchPrice();
    const PRECISION = await stableBaseCDPContract.PRECISION();
    const BASIS_POINTS_DIVISOR = await stableBaseCDPContract.BASIS_POINTS_DIVISOR();
    const liquidationRatio = await stableBaseCDPContract.liquidationRatio();

    const collateralValue = (collateralAmount * collateralPrice) / PRECISION;
    const liquidationThreshold = (borrowedAmount * liquidationRatio) / BASIS_POINTS_DIVISOR;

    if (collateralValue >= liquidationThreshold) {
      console.log(`Collateral is sufficient for Safe ${safeId}, cannot liquidate.`);
      return [false, {}, {}];
    }

    const stabilityPoolContract = context.contracts.stabilityPool as ethers.Contract;
    const isLiquidationPossible = await stabilityPoolContract.isLiquidationPossible(borrowedAmount);

    const head = await safesOrderedForLiquidationContract.getHead();

    if (!isLiquidationPossible && safeId.toString() === head.toString()) {
      console.log(
        "Liquidation not possible with StabilityPool, and it is the last Safe."
      );
      return [false, {}, {}];
    }

    console.log(`Liquidate action can be executed for Safe ${safeId}.`);
    return [true, {}, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const tx = await this.contract
      .connect(actor.account.value)
      .liquidate();
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
    const stableBaseCDPContract = context.contracts.stableBaseCDP as ethers.Contract;
    const safesOrderedForLiquidationContract = context.contracts.safesOrderedForLiquidation as ethers.Contract;

    const safeId = await safesOrderedForLiquidationContract.getTail();
    const safeIdNumber = Number(safeId);

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    if (!previousStableBaseCDPSnapshot || !newStableBaseCDPSnapshot) {
        console.error("StableBaseCDP snapshot not found for validation");
        return false;
    }

    // Safe Removal
    expect(
      newStableBaseCDPSnapshot.safes[safeIdNumber],
      "Safe should be removed from the safes mapping"
    ).to.be.undefined;

    // Total Collateral Update
    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
    const liquidatedSafe = previousStableBaseCDPSnapshot.safes[safeIdNumber];

    if (!liquidatedSafe) {
        console.warn(`Liquidated safe with ID ${safeIdNumber} not found in previous snapshot, skipping collateral and debt validation`);
    } else {
        const expectedNewTotalCollateral = previousTotalCollateral - liquidatedSafe.collateralAmount;
        expect(newTotalCollateral, "Total collateral should be decreased by the liquidated safe's collateral").to.equal(expectedNewTotalCollateral);

        // Total Debt Update
        const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
        const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

        const expectedNewTotalDebt = previousTotalDebt - liquidatedSafe.borrowedAmount;
        expect(newTotalDebt, "Total debt should be decreased by the liquidated safe's borrowed amount").to.equal(expectedNewTotalDebt);
    }

    // Events
    const events = executionReceipt.events;
    const safeRemovedFromLiquidationQueueEvent = events?.find(
      (event) => event.event === "SafeRemovedFromLiquidationQueue"
    );
    expect(safeRemovedFromLiquidationQueueEvent, "SafeRemovedFromLiquidationQueue event should be emitted").to.not
      .be.undefined;

    const safeRemovedFromRedemptionQueueEvent = events?.find(
      (event) => event.event === "SafeRemovedFromRedemptionQueue"
    );
    expect(safeRemovedFromRedemptionQueueEvent, "SafeRemovedFromRedemptionQueue event should be emitted").to.not
      .be.undefined;

    return true;
  }
}
