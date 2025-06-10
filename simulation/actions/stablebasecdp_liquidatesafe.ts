import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

class LiquidateSafeAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("LiquidateSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;

    const safes = stableBaseCDPSnapshot.safes;

    if (!safes || Object.keys(safes).length === 0) {
      console.log("No safes available.");
      return [false, {}, {}];
    }

    // Filter safes that can be liquidated
    const liquidatableSafeIds = Object.keys(safes)
      .map(Number)
      .filter((safeId) => {
        const safe = safes[safeId];
        if (!safe) return false;

        const collateralPrice = mockPriceOracleSnapshot.price; // Use the price from snapshot
        const collateralAmount = safe.collateralAmount;
        const borrowedAmount = safe.borrowedAmount;
        const liquidationRatio = BigInt(12500);
        const BASIS_POINTS_DIVISOR = BigInt(10000);
        const precision = BigInt(10 ** 18);

        const collateralValue = (collateralAmount * collateralPrice) / precision;
        const requiredCollateralValue = (borrowedAmount * liquidationRatio) / BASIS_POINTS_DIVISOR;

        return collateralValue < requiredCollateralValue;
      });

    if (liquidatableSafeIds.length === 0) {
      console.log("No liquidatable safes found.");
      return [false, {}, {}];
    }

    // Randomly select a safe to liquidate
    const safeIdToLiquidate = liquidatableSafeIds[context.prng.next() % liquidatableSafeIds.length];
    const actionParams = {
      safeId: safeIdToLiquidate,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { safeId } = actionParams;

    try {
      const tx = await this.contract.connect(actor.account.value).liquidateSafe(safeId);
      const receipt = await tx.wait();
      return receipt;
    } catch (e) {
      console.error("Execution error:", e);
      throw e;
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { safeId } = actionParams;
    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;

    const safesOrderedForLiquidationPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const safesOrderedForLiquidationNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    const safesOrderedForRedemptionPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;

    const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool;
    const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool;

    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const dfireStakingPrevious = previousSnapshot.contractSnapshot.dfireStaking;
    const dfireStakingNew = newSnapshot.contractSnapshot.dfireStaking;

    // Safe State: safes[safeId] should no longer exist.
    expect(stableBaseCDPNew.safes[safeId]).to.be.undefined;

    // Total Collateral and Debt
    const liquidatedCollateral = stableBaseCDPPrevious.safes[safeId]?.collateralAmount || BigInt(0);
    const liquidatedDebt = stableBaseCDPPrevious.safes[safeId]?.borrowedAmount || BigInt(0);
    expect(stableBaseCDPNew.totalCollateral).to.equal(stableBaseCDPPrevious.totalCollateral - liquidatedCollateral);
    expect(stableBaseCDPNew.totalDebt).to.equal(stableBaseCDPPrevious.totalDebt - liquidatedDebt);

    // Liquidation Queues: The safeId should be removed from both liquidation and redemption queues.
    expect(safesOrderedForLiquidationNew.nodes[safeId]).to.be.undefined;
    expect(safesOrderedForRedemptionNew.nodes[safeId]).to.be.undefined;

    // Check if Stability Pool was used
    const stabilityPoolUsed = stabilityPoolPrevious.totalStakedRaw >= liquidatedDebt;

    if (stabilityPoolUsed) {
      // Stability Pool Interaction
      expect(stabilityPoolNew.totalStakedRaw).to.lessThanOrEqual(stabilityPoolPrevious.totalStakedRaw);
      expect(stabilityPoolNew.stakeScalingFactor).to.lessThanOrEqual(stabilityPoolPrevious.stakeScalingFactor);

      // Token Burning
      expect(dfidTokenNew.totalSupply).to.lessThanOrEqual(dfidTokenPrevious.totalSupply);
      expect(dfidTokenNew.totalBurned).to.greaterThanOrEqual(dfidTokenPrevious.totalBurned);
    } else {
      // If stability pool not used, check other variables.
      expect(stableBaseCDPNew.cumulativeCollateralPerUnitCollateral).to.not.equal(
        stableBaseCDPPrevious.cumulativeCollateralPerUnitCollateral
      );
      expect(stableBaseCDPNew.cumulativeDebtPerUnitCollateral).to.not.equal(
        stableBaseCDPPrevious.cumulativeDebtPerUnitCollateral
      );
      expect(stableBaseCDPNew.collateralLoss).to.not.equal(stableBaseCDPPrevious.collateralLoss);
      expect(stableBaseCDPNew.debtLoss).to.not.equal(stableBaseCDPPrevious.debtLoss);
    }

    // Check DFIRE Staking Pool rewards
    const liquidationFeePaidEvent = executionReceipt.events?.find(
      (event) => event?.event === 'LiquidationFeePaid'
    );

    if (liquidationFeePaidEvent) {
      // Assuming that if LiquidationFeePaid event is emitted, then DFIRE staking pool should have received rewards.
      // Additional checks can be added to validate the amount of rewards received.
      expect(dfireStakingNew.totalCollateralPerToken).to.be.greaterThan(
        dfireStakingPrevious.totalCollateralPerToken
      );
    }

    return true;
  }
}

export default LiquidateSafeAction;
