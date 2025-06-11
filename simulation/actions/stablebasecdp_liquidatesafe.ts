import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class LiquidateSafeAction extends Action {
  private contract: ethers.Contract;

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
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
    const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;

    if (!stableBaseCDPSnapshot.safes) {
      return [false, {}, {}];
    }

    let safeIdToLiquidate: bigint | undefined;
    let borrowedAmount: bigint | undefined;
    let collateralAmount: bigint | undefined;

    const safeIds = Object.keys(stableBaseCDPSnapshot.safes);

    for (const safeId of safeIds) {
      const safe = stableBaseCDPSnapshot.safes[safeId];

      if (
        safe.collateralAmount > BigInt(0) &&
        safe.borrowedAmount > BigInt(0)
      ) {
        const collateralPrice = mockPriceOracleSnapshot.price;
        const collateralValue = (safe.collateralAmount * collateralPrice) / BigInt(10 ** 18); // PRECISION
        const liquidationRatio = BigInt(11000); // Example: 110%
        const BASIS_POINTS_DIVISOR = BigInt(10000);

        if (
          collateralValue <
          (safe.borrowedAmount * liquidationRatio) / BASIS_POINTS_DIVISOR
        ) {
          // Check if liquidation via secondary mechanism is required and safeId is not the last Safe
          const possible = stabilityPoolSnapshot.totalStakedRaw >= safe.borrowedAmount;
          const lastSafeId = safesOrderedForLiquidationSnapshot.head;

          if (!possible && BigInt(safeId) === lastSafeId) {
            continue; // Skip this safe as it's the last one and stability pool can't liquidate
          }

          safeIdToLiquidate = BigInt(safeId);
          borrowedAmount = safe.borrowedAmount;
          collateralAmount = safe.collateralAmount;
          break;
        }
      }
    }

    if (!safeIdToLiquidate) {
      return [false, {}, {}];
    }

    return [true, [safeIdToLiquidate], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const safeId = actionParams[0];

    const tx = await this.contract
      .connect(actor.account.value)
      .liquidateSafe(safeId);
    return { receipt: await tx.wait() };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const safeId = actionParams[0];
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousOrderedDoublyLinkedListSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const newOrderedDoublyLinkedListSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

    // Safe Removal
    expect(newStableBaseCDPSnapshot.safes[Number(safeId)], `safes[${safeId}] should not exist`).to.be.undefined;

    const stableBaseCDPContract = context.contracts.stableBaseCDP;
    const ownerOfFunction = stableBaseCDPContract.interface.getFunction("_ownerOf");
    const callData = stableBaseCDPContract.interface.encodeFunctionData(ownerOfFunction, [safeId]);
    const ownerOfResult = await context.contracts.stableBaseCDP.provider.call({
      to: stableBaseCDPContract.target,
      data: callData,
    });
    const decodedResult = stableBaseCDPContract.interface.decodeFunctionResult(ownerOfFunction, ownerOfResult);
    expect(decodedResult[0]).to.equal(ethers.ZeroAddress, `NFT representing Safe ${safeId} should be owned by zero address`);

    // Get Previous and New values to make necessary assertions
    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    const previousSafe = previousStableBaseCDPSnapshot.safes[Number(safeId)];
    // Global Debt and Collateral Consistency. Assuming liquidation removes all collateral and debt.
    const liquidatedCollateralAmount = previousSafe.collateralAmount;
    const liquidatedBorrowedAmount = previousSafe.borrowedAmount;

    expect(newTotalCollateral, "totalCollateral should be decreased by the liquidated collateralAmount").to.equal(previousTotalCollateral - liquidatedCollateralAmount);
    expect(newTotalDebt, "totalDebt should be decreased by the liquidated borrowedAmount").to.equal(previousTotalDebt - liquidatedBorrowedAmount);

    // Liquidation Queue Removal
    if (previousOrderedDoublyLinkedListSnapshot.nodes && previousOrderedDoublyLinkedListSnapshot.nodes[Number(safeId)]) {
      expect(newOrderedDoublyLinkedListSnapshot.nodes[Number(safeId)], `safeId ${safeId} should no longer exist in safesOrderedForLiquidation`).to.be.undefined;
    }

    // Stability Pool State (If Applicable)
    const stabilityPoolUsed = previousStabilityPoolSnapshot.totalStakedRaw >= liquidatedBorrowedAmount;
    if (stabilityPoolUsed) {
      expect(newStabilityPoolSnapshot.totalStakedRaw, "Stability Pool's totalStakedRaw should decrease by borrowedAmount").to.equal(previousStabilityPoolSnapshot.totalStakedRaw - liquidatedBorrowedAmount);
      expect(newDFIDTokenSnapshot.balances[context.contracts.stabilityPool.target], "Stability Pool's SBD token balance should decrease by borrowedAmount").to.equal(previousDFIDTokenSnapshot.balances[context.contracts.stabilityPool.target] - liquidatedBorrowedAmount);
    }

    // Fee Distribution - Add validation for DFIREStaking and StabilityPool collateral token balance increase if applicable
    // This requires more context about how fees are distributed.  Assuming no distribution for now.

    // Protocol Mode Validation
    if (
      previousTotalDebt > stableBaseCDPSnapshot.bootstrapModeDebtThreshold &&
      previousStableBaseCDPSnapshot.protocolMode === 0 //SBStructs.Mode.BOOTSTRAP
    ) {
      expect(newStableBaseCDPSnapshot.protocolMode, "Protocol mode should change from BOOTSTRAP to NORMAL").to.equal(1); //SBStructs.Mode.NORMAL
    }

    // Validate account balances (ETH)
    const gasUsed = executionReceipt.receipt.gasUsed;
    const block = await context.contracts.stableBaseCDP.provider.getBlock(executionReceipt.receipt.blockNumber || 'latest');
    const baseFee = block?.baseFeePerGas || BigInt(0);
    const gasCompensation = (gasUsed + previousStableBaseCDPSnapshot.extraGasCompensation) * (baseFee + (baseFee * BigInt(10)) / BigInt(100));
    const liquidationFee = (liquidatedCollateralAmount * previousStableBaseCDPSnapshot.redemptionLiquidationFee) / BigInt(10000); //BASIS_POINTS_DIVISOR

    const refund = gasCompensation < liquidationFee ? gasCompensation : liquidationFee;

    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    expect(newAccountBalance - previousAccountBalance, "Account balance should be increased by refund").to.equal(refund);

    return true;
  }
}
