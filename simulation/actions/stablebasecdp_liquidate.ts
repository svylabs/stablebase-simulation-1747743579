import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class LiquidateAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("LiquidateAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;

    if (!safesOrderedForLiquidationSnapshot.tail || safesOrderedForLiquidationSnapshot.tail === BigInt(0)) {
      return [false, {}, {}];
    }

    const safeId = safesOrderedForLiquidationSnapshot.tail;
    const safe = stableBaseCDPSnapshot.safes[Number(safeId)];

    if (!safe || safe.borrowedAmount <= BigInt(0)) {
      return [false, {}, {}];
    }

    const priceOracle = context.contracts.mockPriceOracle;
    const collateralPrice = await priceOracle.fetchPrice();
    const collateralValue = (safe.collateralAmount * collateralPrice) / BigInt(10 ** 18);
    const liquidationRatio = BigInt(stableBaseCDPSnapshot.redemptionLiquidationFee);
    const borrowedAmount = safe.borrowedAmount;

    if (collateralValue >= ((borrowedAmount * liquidationRatio) / BigInt(10000))) {
      return [false, {}, {}];
    }

    const accountBalance = currentSnapshot.accountSnapshot[actor.account.address];
    if (accountBalance === undefined || accountBalance <= BigInt(0)) {
      return [false, {}, {}];
    }

    const gasLimit = stableBaseCDPSnapshot.extraGasCompensation + BigInt(200000); // Adding a base gas limit

    return [true, { gasLimit }, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    return this.contract
      .connect(actor.account.value)
      .liquidate({
        gasLimit: actionParams.gasLimit,
      });
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const previousSafesOrderedForLiquidationSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const newSafesOrderedForLiquidationSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const previousSafesOrderedForRedemptionSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const newSafesOrderedForRedemptionSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

    const safesOrderedForLiquidationSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const safeId = safesOrderedForLiquidationSnapshot.tail;
    const safe = previousStableBaseCDPSnapshot.safes[Number(safeId)];

    if (!safe) {
      return false;
    }

    // Safe validations
    expect(newStableBaseCDPSnapshot.safes[Number(safeId)], `Safe ${safeId} should be deleted`).to.be.undefined;
    expect(newSafesOrderedForLiquidationSnapshot.nodes[Number(safeId)], `Safe ${safeId} should be removed from liquidation queue`).to.be.undefined;
    expect(newSafesOrderedForRedemptionSnapshot.nodes[Number(safeId)], `Safe ${safeId} should be removed from redemption queue`).to.be.undefined;

    // Protocol validations
    expect(newStableBaseCDPSnapshot.totalCollateral, "Total collateral should decrease").to.equal(previousStableBaseCDPSnapshot.totalCollateral - safe.collateralAmount);
    expect(newStableBaseCDPSnapshot.totalDebt, "Total debt should decrease").to.equal(previousStableBaseCDPSnapshot.totalDebt - safe.borrowedAmount);

    // StabilityPool validations
    const stabilityPoolAddress = (context.contracts.stabilityPool as any).target;
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    //DFIDToken validations
    const previousTotalSupply = previousDFIDTokenSnapshot.totalSupply;
    const newTotalSupply = newDFIDTokenSnapshot.totalSupply;
    expect(newTotalSupply, "Total supply should decrease").to.equal(previousTotalSupply - safe.borrowedAmount);
    expect(newDFIDTokenSnapshot.balances[stabilityPoolAddress], "Stability pool balance should decrease").to.equal(previousDFIDTokenSnapshot.balances[stabilityPoolAddress] - safe.borrowedAmount);

    //DFIREStaking Validations
    const dfireStakingAddress = (context.contracts.dfireStaking as any).target;
    const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

    const borrowedAmount = safe.borrowedAmount;
    const burnedAmount = previousDFIDTokenSnapshot.balances[stabilityPoolAddress] - newDFIDTokenSnapshot.balances[stabilityPoolAddress];

    // Account Balances Validation
    const previousActorBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newActorBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    //Events Validation
    let eventFound = false;
    if (executionReceipt && executionReceipt.logs) {
      for (const log of executionReceipt.logs) {
        if (log.address === (context.contracts.stableBaseCDP as any).target) {
            const parsedLog = this.contract.interface.parseLog(log);

            if (parsedLog && (parsedLog.name === 'LiquidatedUsingStabilityPool' || parsedLog.name === 'LiquidatedUsingSecondaryMechanism')) {
                eventFound = true;
                break;
            }
        }
      }
    }

    expect(eventFound, 'LiquidatedUsingStabilityPool or LiquidatedUsingSecondaryMechanism event should be emitted').to.be.true;

    return true;
  }
}
