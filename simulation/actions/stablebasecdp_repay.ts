import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

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

    if (!stableBaseCDPSnapshot || !dfidTokenSnapshot) {
      console.warn("Missing contract snapshots");
      return [false, {}, {}];
    }

    let safeId = BigInt(context.prng.next()) % BigInt(100) + BigInt(1);
    const accountAddress = actor.account.address;

    // Fetch safe information using safeId
    let safe = stableBaseCDPSnapshot.safeInfo;
    if (!stableBaseCDPSnapshot.safeInfo) {
      console.warn("Safe information not found in the snapshot.");
      return [false, {}, {}];
    }

    const sbdTokenBalance = currentSnapshot.accountSnapshot[context.contracts.dfidToken.target] || BigInt(0);
    if (sbdTokenBalance <= BigInt(0)) {
      console.warn("Insufficient SBD balance to repay.");
      return [false, {}, {}];
    }

    let amount = BigInt(context.prng.next()) % sbdTokenBalance;

    if (amount <= BigInt(0)) {
      amount = BigInt(1);
    }

    if (amount > safe.borrowedAmount) {
      amount = safe.borrowedAmount;
    }

    const MINIMUM_DEBT = BigInt(100);
    if (safe.borrowedAmount - amount < MINIMUM_DEBT && safe.borrowedAmount - amount !== BigInt(0)) {
      amount = safe.borrowedAmount > MINIMUM_DEBT ? safe.borrowedAmount - MINIMUM_DEBT : safe.borrowedAmount;
    }

    if (amount <= BigInt(0)) {
      console.warn("Repayment amount is zero or negative after adjustments.");
      return [false, {}, {}];
    }

    const nearestSpotInLiquidationQueue = BigInt(0);

    // Check if safe exists and is owned by the actor
    let safeExists = false;
    if (stableBaseCDPSnapshot.safeInfo) {
            safeExists = true;
    }

    if (!safeExists) {
      console.warn("Safe does not exist or is not owned by the actor.");
      return [false, {}, {}];
    }

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
    const signer = actor.account.value.connect(context.provider);

    try {
      const tx = await this.contract.connect(signer).repay(
        actionParams.safeId,
        actionParams.amount,
        actionParams.nearestSpotInLiquidationQueue
      );
      const receipt = await tx.wait();
      return receipt;
    } catch (error: any) {
      console.error("Transaction failed:", error);
      throw error;
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
    const safeId = actionParams.safeId;
    const amount = actionParams.amount;

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

    const previousAccountSnapshot = previousSnapshot.accountSnapshot;
    const newAccountSnapshot = newSnapshot.accountSnapshot;

    if (!previousStableBaseCDPSnapshot || !newStableBaseCDPSnapshot || !previousDFIDTokenSnapshot || !newDFIDTokenSnapshot) {
      console.warn("Missing contract snapshots");
      return false;
    }

    // CDP Debt Repayment validations
    const prevSafe = previousStableBaseCDPSnapshot.safeInfo;
    const newSafe = newStableBaseCDPSnapshot.safeInfo;

    if (prevSafe && newSafe) {
      expect(newSafe.borrowedAmount, "borrowedAmount should be decreased by amount").to.equal(prevSafe.borrowedAmount - amount);
    }

    expect(newStableBaseCDPSnapshot.totalDebt, "totalDebt should be decreased by amount").to.equal(previousStableBaseCDPSnapshot.totalDebt - amount);

    const previousSBDTokenBalance = previousAccountSnapshot[actor.account.address] || BigInt(0);
    const newSBDTokenBalance = newAccountSnapshot[actor.account.address] || BigInt(0);

    expect(newSBDTokenBalance, "SBD token balance should be decreased by amount").to.equal(previousSBDTokenBalance - amount);
    expect(newDFIDTokenSnapshot.totalSupplyAmount, "Total supply of SBD tokens should be reduced by the repaid amount.").to.equal(previousDFIDTokenSnapshot.totalSupplyAmount - amount);
    expect(newDFIDTokenSnapshot.totalBurnedAmount, "Total burned amount should be increased by repaid amount").to.equal(previousDFIDTokenSnapshot.totalBurnedAmount + amount);

    // Check for protocol mode change
    if (previousStableBaseCDPSnapshot.currentMode === 0 && newStableBaseCDPSnapshot.currentMode === 1) {
      // Assuming 0 is BOOTSTRAP and 1 is NORMAL.  Validate the mode change if necessary
      expect(newStableBaseCDPSnapshot.totalDebt, "totalDebt should be less than BOOTSTRAP_MODE_DEBT_THRESHOLD").to.be.lessThan(BigInt(1000)); // Replace 1000 with actual threshold
    }

    // Need to add checks for safesOrderedForLiquidation, safesOrderedForRedemption, cumulativeDebtPerUnitCollateral, cumulativeCollateralPerUnitCollateral and totalCollateral

    return true;
  }
}
