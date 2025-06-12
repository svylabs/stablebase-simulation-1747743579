import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
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
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeOwners = stableBaseCDPSnapshot.safeOwners;
    const safeIds = Object.keys(safeOwners).map(Number);

    let safeId: number | undefined = undefined;
    for (const id of safeIds) {
      if (safeOwners[id] === actor.account.address) {
        safeId = id;
        break;
      }
    }

    if (safeId === undefined) {
      console.log("No Safe found for this actor");
      return [false, {}, {}];
    }

    const safeData = stableBaseCDPSnapshot.safesData[safeId];

    if (!safeData || safeData.collateralAmount <= BigInt(0)) {
      console.log("No collateral to withdraw or Safe does not exist");
      return [false, {}, {}];
    }

    const amount = (context.prng.next() % Number(safeData.collateralAmount)) + 1;
    const nearestSpotInLiquidationQueue = 0;
    const actionParams = {
      safeId: BigInt(safeId),
      amount: BigInt(amount),
      nearestSpotInLiquidationQueue: BigInt(nearestSpotInLiquidationQueue),
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    return await this.contract
      .connect(actor.account.value)
      .withdrawCollateral(
        actionParams.safeId,
        actionParams.amount,
        actionParams.nearestSpotInLiquidationQueue
      );
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

    const previousSafeData = previousStableBaseCDPSnapshot.safesData[Number(safeId)];
    const newSafeData = newStableBaseCDPSnapshot.safesData[Number(safeId)];

    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;

    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    const previousProtocolMode = previousStableBaseCDPSnapshot.protocolMode;
    const newProtocolMode = newStableBaseCDPSnapshot.protocolMode;

    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    const previousContractBalance = previousSnapshot.accountSnapshot[this.contract.target] || BigInt(0);
    const newContractBalance = newSnapshot.accountSnapshot[this.contract.target] || BigInt(0);

    // Safe State Validation
    expect(newSafeData.collateralAmount).to.equal(previousSafeData.collateralAmount - amount, "Safe collateral amount should be decreased by amount");
    expect(newSafeData.collateralAmount).to.be.at.least(BigInt(0), "Safe collateral amount must be non-negative");

    // Protocol State Validation
    expect(newTotalCollateral).to.equal(previousTotalCollateral - amount, "Total collateral should be decreased by amount");

    // Balance Validation
    expect(newAccountBalance).to.equal(previousAccountBalance + amount, "Account balance should be increased by amount");
    expect(newContractBalance).to.equal(previousContractBalance - amount, "Contract balance should be decreased by amount");

    // Check if the safe was removed from liquidation queues
    const previousLiquidationQueue = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes;
    const newLiquidationQueue = newSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes;
    if (previousSafeData.borrowedAmount === BigInt(0) && previousLiquidationQueue[Number(safeId)]) {
      expect(newLiquidationQueue[Number(safeId)]).to.be.undefined;
    }
    const cumulativeDebtPerUnitCollateralPrevious = previousStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral;
    const cumulativeDebtPerUnitCollateralNew = newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral;

    const cumulativeCollateralPerUnitCollateralPrevious = previousStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral;
    const cumulativeCollateralPerUnitCollateralNew = newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral;

    let debtIncrease = BigInt(0);
    let collateralIncrease = BigInt(0);

    if (cumulativeDebtPerUnitCollateralPrevious!=cumulativeDebtPerUnitCollateralNew){
         // Validate borrowed amount updates
        debtIncrease = (previousSafeData.collateralAmount *
         (cumulativeDebtPerUnitCollateralNew -
         cumulativeDebtPerUnitCollateralPrevious)) / BigInt(10**18);
         expect(newSafeData.borrowedAmount).to.equal(previousSafeData.borrowedAmount + debtIncrease, 'Borrowed amount should be  updated');
         expect(newSafeData.totalBorrowedAmount).to.equal(previousSafeData.totalBorrowedAmount + debtIncrease, 'Total borrowed amount should be  updated');
    }

    if (cumulativeCollateralPerUnitCollateralPrevious!=cumulativeCollateralPerUnitCollateralNew){
        collateralIncrease = (previousSafeData.collateralAmount *
        (cumulativeCollateralPerUnitCollateralNew -
        cumulativeCollateralPerUnitCollateralPrevious)) / BigInt(10**18);

    }

    const BOOTSTRAP_MODE_DEBT_THRESHOLD = BigInt(5000000) * BigInt(10) ** BigInt(18);
    if(previousTotalDebt + debtIncrease > BOOTSTRAP_MODE_DEBT_THRESHOLD && previousProtocolMode == 0 && newProtocolMode == 1){
      expect(newProtocolMode).to.equal(1, "Protocol should be updated to Normal Mode.");
    }
    expect(newTotalDebt).to.equal(previousTotalDebt + debtIncrease - collateralIncrease, "Total debt should be correctly updated");


    return true;
  }
}
