import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

// Assuming standard values for these constants based on context and common DeFi practices
const BASIS_POINTS_DIVISOR = 10000n;
const PRECISION = 10n ** 18n;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * (10n ** 18n);
const LIQUIDATION_RATIO = 1_500_000_000_000_000_000n; // Represents 1.5 (150%) scaled by PRECISION

// Assuming SBStructs.Mode values from common Solidity enum patterns
const SB_MODE_BOOTSTRAP = 0;
const SB_MODE_NORMAL = 1;

export class WithdrawcollateralAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("WithdrawcollateralAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const cdpSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const priceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;

    // Find safes owned by the actor
    const actorSafes = Object.entries(cdpSnapshot.safeOwner).filter(
      ([safeId, ownerAddress]) => ownerAddress === actor.account.address
    ).map(([safeId, _]) => BigInt(safeId));

    if (actorSafes.length === 0) {
      return [false, {}, {}];
    }

    // Filter out safes with no collateral or where withdrawal is impossible
    let eligibleSafeIds: bigint[] = [];
    for (const safeId of actorSafes) {
      const prevSafeDetails = cdpSnapshot.safeDetails[safeId];

      if (!prevSafeDetails || prevSafeDetails.collateralAmount === 0n) {
        continue; // Skip safes with no collateral
      }

      // Simulate _updateSafe logic to get effective collateral and borrowed amounts
      const safeLiquidationSnapshot = cdpSnapshot.liquidationSnapshots?.[safeId];

      const snapshotCollateralPerCollateral = safeLiquidationSnapshot?.cumulativeCollateralPerUnitCollateral || 0n;
      const snapshotDebtPerCollateral = safeLiquidationSnapshot?.cumulativeDebtPerCollateral || 0n;

      let effectiveCollateralAmount = prevSafeDetails.collateralAmount;
      let effectiveBorrowedAmount = prevSafeDetails.borrowedAmount;

      if (
        snapshotCollateralPerCollateral !== cdpSnapshot.cumulativeCollateralPerUnitCollateral
      ) {
        const collateralIncrease = (prevSafeDetails.collateralAmount *
          (cdpSnapshot.cumulativeCollateralPerUnitCollateral -
            snapshotCollateralPerCollateral)) / PRECISION;
        effectiveCollateralAmount += collateralIncrease;

        const debtIncrease = (prevSafeDetails.collateralAmount *
          (cdpSnapshot.cumulativeDebtPerCollateral -
            snapshotDebtPerCollateral)) / PRECISION;
        effectiveBorrowedAmount += debtIncrease;
      }

      let maxWithdrawal = 0n;
      if (effectiveBorrowedAmount > 0n) {
        const price = priceOracleSnapshot.fetchedPrice;
        if (price === 0n) continue; // Cannot calculate if price is 0

        const minCollateralRequired = (effectiveBorrowedAmount * LIQUIDATION_RATIO) /
          (price * BASIS_POINTS_DIVISOR / PRECISION); // Adjusted division for proper scaling

        if (effectiveCollateralAmount <= minCollateralRequired) {
          maxWithdrawal = 0n; // Cannot withdraw without breaching liquidation ratio
        } else {
          maxWithdrawal = effectiveCollateralAmount - minCollateralRequired;
        }
      } else {
        maxWithdrawal = effectiveCollateralAmount;
      }

      if (maxWithdrawal > 0n) {
        eligibleSafeIds.push(safeId);
      }
    }

    if (eligibleSafeIds.length === 0) {
      return [false, {}, {}];
    }

    const safeId = eligibleSafeIds[context.prng.next() % eligibleSafeIds.length];
    const safeDetails = cdpSnapshot.safeDetails[safeId];
    const safeLiquidationSnapshot = cdpSnapshot.liquidationSnapshots?.[safeId];

    // Recalculate effective amounts for the chosen safeId for amount generation
    let effectiveCollateralAmount = safeDetails.collateralAmount;
    let effectiveBorrowedAmount = safeDetails.borrowedAmount;

    const snapshotCollateralPerCollateral = safeLiquidationSnapshot?.cumulativeCollateralPerUnitCollateral || 0n;
    const snapshotDebtPerCollateral = safeLiquidationSnapshot?.cumulativeDebtPerCollateral || 0n;

    if (
      snapshotCollateralPerCollateral !== cdpSnapshot.cumulativeCollateralPerUnitCollateral
    ) {
      const collateralIncrease = (safeDetails.collateralAmount *
        (cdpSnapshot.cumulativeCollateralPerUnitCollateral -
          snapshotCollateralPerCollateral)) / PRECISION;
      effectiveCollateralAmount += collateralIncrease;

      const debtIncrease = (safeDetails.collateralAmount *
        (cdpSnapshot.cumulativeDebtPerCollateral -
          snapshotDebtPerCollateral)) / PRECISION;
      effectiveBorrowedAmount += debtIncrease;
    }

    let maxWithdrawal = 0n;
    if (effectiveBorrowedAmount > 0n) {
      const price = priceOracleSnapshot.fetchedPrice;
      const minCollateralRequired = (effectiveBorrowedAmount * LIQUIDATION_RATIO) /
        (price * BASIS_POINTS_DIVISOR / PRECISION);
      maxWithdrawal = effectiveCollateralAmount - minCollateralRequired;
    } else {
      maxWithdrawal = effectiveCollateralAmount;
    }

    if (maxWithdrawal <= 0n) {
      return [false, {}, {}]; // Should ideally be caught by eligibleSafeIds filter, but a safety check
    }

    // Generate a random amount to withdraw, at least 1 wei
    const amount = context.prng.nextBigInt(1n, maxWithdrawal);

    let nearestSpotInLiquidationQueue = 0n;
    if (effectiveBorrowedAmount > 0n) {
      const liquidationQueueNodes = Object.keys(currentSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes);
      if (liquidationQueueNodes.length > 0) {
        const randomIndex = context.prng.next() % liquidationQueueNodes.length;
        nearestSpotInLiquidationQueue = BigInt(liquidationQueueNodes[randomIndex]);
      } else {
        nearestSpotInLiquidationQueue = 0n; // No nodes, so hint is 0
      }
    } else {
        // If borrowedAmount is 0, safe will be removed, so nearestSpot is less critical
        nearestSpotInLiquidationQueue = 0n;
    }

    const actionParams = {
      safeId,
      amount,
      nearestSpotInLiquidationQueue,
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

    const receipt = await this.contract.connect(actor.account.value).withdrawCollateral(
      safeId,
      amount,
      nearestSpotInLiquidationQueue
    );
    return receipt;
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;

    const cdpContractAddress = this.contract.target as string;
    const actorAddress = actor.account.address;

    const prevCdpSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newCdpSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const prevAccountSnapshot = previousSnapshot.accountSnapshot;
    const newAccountSnapshot = newSnapshot.accountSnapshot;

    const prevLiquidationQueueSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const newLiquidationQueueSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    const prevRedemptionQueueSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const newRedemptionQueueSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

    let allValidationsPassed = true;

    // 1. Event Emission Validation
    const safeUpdatedEvent = executionReceipt.events.find(
      (event: any) => event.fragment.name === "SafeUpdated"
    );
    expect(safeUpdatedEvent, "SafeUpdated event not emitted").to.not.be.undefined;

    const withdrawnCollateralEvent = executionReceipt.events.find(
      (event: any) => event.fragment.name === "WithdrawnCollateral"
    );
    expect(withdrawnCollateralEvent, "WithdrawnCollateral event not emitted").to.not.be.undefined;

    const { collateralIncrease, debtIncrease, collateralAmount: safeUpdatedCollateralAmount, borrowedAmount: safeUpdatedBorrowedAmount, totalCollateral: totalCollateralFromUpdateEvent, totalDebt: totalDebtFromUpdateEvent } = safeUpdatedEvent.args;
    const { safeId: withdrawnEventSafeId, amount: withdrawnEventAmount, totalCollateral: finalTotalCollateralFromEvent, totalDebt: finalTotalDebtFromEvent } = withdrawnCollateralEvent.args;

    expect(withdrawnEventSafeId).to.equal(safeId, "WithdrawnCollateral event safeId mismatch");
    expect(withdrawnEventAmount).to.equal(amount, "WithdrawnCollateral event amount mismatch");

    // Simulate initial effective borrowed amount based on previous snapshot
    const prevSafeDetails = prevCdpSnapshot.safeDetails[safeId];
    const prevSafeLiquidationSnapshot = prevCdpSnapshot.liquidationSnapshots?.[safeId];

    const prevSnapshotCollateralPerCollateral = prevSafeLiquidationSnapshot?.cumulativeCollateralPerUnitCollateral || 0n;
    const prevSnapshotDebtPerCollateral = prevSafeLiquidationSnapshot?.cumulativeDebtPerCollateral || 0n;

    let initialEffectiveBorrowedAmount = prevSafeDetails.borrowedAmount;
    if (
      prevSnapshotCollateralPerCollateral !== prevCdpSnapshot.cumulativeCollateralPerUnitCollateral
    ) {
      const simulatedDebtIncrease = (prevSafeDetails.collateralAmount *
        (prevCdpSnapshot.cumulativeDebtPerCollateral -
          prevSnapshotDebtPerCollateral)) / PRECISION;
      initialEffectiveBorrowedAmount += simulatedDebtIncrease;
    }

    if (initialEffectiveBorrowedAmount > 0n) {
      const liquidationQueueUpdatedEvent = executionReceipt.events.find(
        (event: any) => event.fragment.name === "LiquidationQueueUpdated"
      );
      expect(liquidationQueueUpdatedEvent, "LiquidationQueueUpdated event not emitted").to.not.be.undefined;
    } else {
      const safeRemovedFromLiquidationQueueEvent = executionReceipt.events.find(
        (event: any) => event.fragment.name === "SafeRemovedFromLiquidationQueue"
      );
      expect(safeRemovedFromLiquidationQueueEvent, "SafeRemovedFromLiquidationQueue event not emitted").to.not.be.undefined;

      const safeRemovedFromRedemptionQueueEvent = executionReceipt.events.find(
        (event: any) => event.fragment.name === "SafeRemovedFromRedemptionQueue"
      );
      expect(safeRemovedFromRedemptionQueueEvent, "SafeRemovedFromRedemptionQueue event not emitted").to.not.be.undefined;
    }

    // 2. Safe and Global State Validation
    const newSafeDetails = newCdpSnapshot.safeDetails[safeId];
    const prevSafeTotalBorrowedAmount = prevCdpSnapshot.safeDetails[safeId].totalBorrowedAmount;

    // Calculate expected collateral amount after _updateSafe and then withdrawal
    const expectedCollateralAfterUpdate = prevCdpSnapshot.safeDetails[safeId].collateralAmount + collateralIncrease;
    expect(newSafeDetails.collateralAmount).to.equal(expectedCollateralAfterUpdate - amount, "Safe collateralAmount mismatch");

    // Verify borrowed amount from SafeUpdated event
    expect(newSafeDetails.borrowedAmount).to.equal(safeUpdatedBorrowedAmount, "Safe borrowedAmount mismatch");

    // Verify totalBorrowedAmount
    expect(newSafeDetails.totalBorrowedAmount).to.equal(prevSafeTotalBorrowedAmount + debtIncrease, "Safe totalBorrowedAmount mismatch");

    // Verify liquidation snapshots
    expect(newCdpSnapshot.liquidationSnapshots[safeId].cumulativeCollateralPerUnitCollateral).to.equal(
      newCdpSnapshot.cumulativeCollateralPerUnitCollateral,
      "liquidationSnapshots collateralPerCollateralSnapshot mismatch"
    );
    expect(newCdpSnapshot.liquidationSnapshots[safeId].cumulativeDebtPerCollateral).to.equal(
      newCdpSnapshot.cumulativeDebtPerCollateral,
      "liquidationSnapshots debtPerCollateralSnapshot mismatch"
    );

    // Verify totalCollateral
    const expectedTotalCollateral = prevCdpSnapshot.totalCollateral + collateralIncrease - amount;
    expect(newCdpSnapshot.totalCollateral).to.equal(expectedTotalCollateral, "Total collateral mismatch");
    expect(newCdpSnapshot.totalCollateral).to.equal(finalTotalCollateralFromEvent, "Total collateral from event mismatch");

    // Verify totalDebt
    const expectedTotalDebt = prevCdpSnapshot.totalDebt + debtIncrease;
    expect(newCdpSnapshot.totalDebt).to.equal(expectedTotalDebt, "Total debt mismatch");
    expect(newCdpSnapshot.totalDebt).to.equal(finalTotalDebtFromEvent, "Total debt from event mismatch");

    // Verify PROTOCOL_MODE
    if (
      prevCdpSnapshot.protocolMode === SB_MODE_BOOTSTRAP &&
      newCdpSnapshot.totalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD
    ) {
      expect(newCdpSnapshot.protocolMode).to.equal(SB_MODE_NORMAL, "PROTOCOL_MODE should transition to NORMAL");
    } else {
      expect(newCdpSnapshot.protocolMode).to.equal(prevCdpSnapshot.protocolMode, "PROTOCOL_MODE should remain unchanged");
    }

    // 3. Collateral Transfer Validation
    const gasUsed = BigInt(executionReceipt.gasUsed);
    const gasPrice = BigInt(executionReceipt.gasPrice);
    const txFee = gasUsed * gasPrice;

    // Actor's ETH balance should increase by amount, minus gas fee
    const expectedActorEthBalance = prevAccountSnapshot[actorAddress] + amount - txFee;
    expect(newAccountSnapshot[actorAddress]).to.equal(expectedActorEthBalance, "Actor ETH balance mismatch");

    // StableBaseCDP contract's ETH balance should decrease by amount
    const expectedCdpEthBalance = prevAccountSnapshot[cdpContractAddress] - amount;
    expect(newAccountSnapshot[cdpContractAddress]).to.equal(expectedCdpEthBalance, "StableBaseCDP ETH balance mismatch");

    // 4. Queue State Validation
    if (initialEffectiveBorrowedAmount > 0n) {
      // Safe remained in liquidation queue
      expect(newLiquidationQueueSnapshot.nodes[safeId]).to.not.be.undefined,
        "Safe node should exist in liquidation queue";
      // Detailed validation of position (prev/next pointers) is complex without a queue model
      // We'll rely on the event emission for now and simple node existence.
    } else {
      // Safe removed from both queues
      expect(newLiquidationQueueSnapshot.nodes[safeId]).to.be.undefined,
        "Safe node should be removed from liquidation queue";
      expect(newRedemptionQueueSnapshot.nodes[safeId]).to.be.undefined,
        "Safe node should be removed from redemption queue";

      // Verify head/tail pointers if the removed safe was head/tail
      if (prevLiquidationQueueSnapshot.headId === safeId) {
          expect(newLiquidationQueueSnapshot.headId).to.equal(prevLiquidationQueueSnapshot.nodes[safeId].next, "Liquidation queue head not updated correctly");
      }
      if (prevLiquidationQueueSnapshot.tailId === safeId) {
          expect(newLiquidationQueueSnapshot.tailId).to.equal(prevLiquidationQueueSnapshot.nodes[safeId].prev, "Liquidation queue tail not updated correctly");
      }

      if (prevRedemptionQueueSnapshot.headId === safeId) {
          expect(newRedemptionQueueSnapshot.headId).to.equal(prevRedemptionQueueSnapshot.nodes[safeId].next, "Redemption queue head not updated correctly");
      }
      if (prevRedemptionQueueSnapshot.tailId === safeId) {
          expect(newRedemptionQueueSnapshot.tailId).to.equal(prevRedemptionQueueSnapshot.nodes[safeId].prev, "Redemption queue tail not updated correctly");
      }
    }

    return allValidationsPassed;
  }
}
