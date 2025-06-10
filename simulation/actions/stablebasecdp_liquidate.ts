import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
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
    const accountSnapshot = currentSnapshot.accountSnapshot;
    const actorAddress = actor.account.address;
    const actorBalance = accountSnapshot[actorAddress] || BigInt(0);
    if (actorBalance <= BigInt(0)) {
      return [false, {}, {}];
    }

    const safesOrderedForLiquidation = context.contracts.safesOrderedForLiquidation;
    const tail = (await (safesOrderedForLiquidation as ethers.Contract).getTail.callStatic()) as bigint;

    if (tail === BigInt(0)) {
      return [false, {}, {}];
    }

    // No parameters needed for liquidate function.
    return [true, {}, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    return this.contract.connect(actor.account.value).liquidate();
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
    const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool;
    const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool;
    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const safeId = (await (context.contracts.safesOrderedForLiquidation as ethers.Contract).getTail.callStatic()) as bigint;

    // Validate totalCollateral decrease
    const expectedTotalCollateral = stableBaseCDPPrevious.totalCollateral;
    expect(stableBaseCDPNew.totalCollateral).to.be.lte(expectedTotalCollateral, "totalCollateral should decrease or remain the same");

    // Validate totalDebt decrease
    const expectedTotalDebt = stableBaseCDPPrevious.totalDebt;
    expect(stableBaseCDPNew.totalDebt).to.be.lte(expectedTotalDebt, "totalDebt should decrease or remain the same");

    // Protocol mode change validation
    if (
      stableBaseCDPPrevious.currentMode === 0 &&
      stableBaseCDPNew.currentMode === 1 &&
      stableBaseCDPPrevious.totalDebt > BigInt(stableBaseCDPPrevious.inactiveDebt) // Assuming inactiveDebt is similar to BOOTSTRAP_MODE_DEBT_THRESHOLD
    ) {
      expect(stableBaseCDPNew.currentMode).to.equal(1, "PROTOCOL_MODE should be NORMAL");
    }

    if (stabilityPoolPrevious.totalStakedRaw >= stableBaseCDPPrevious.totalDebt) {
      expect(dfidTokenNew.totalSupplyAmount).to.equal(dfidTokenPrevious.totalSupplyAmount - stableBaseCDPPrevious.totalDebt, "DFID Token supply should decrease when liquidated via stability pool.");
      expect(dfidTokenNew.totalBurnedAmount).to.equal(dfidTokenPrevious.totalBurnedAmount + stableBaseCDPPrevious.totalDebt, "totalBurned should be increased by borrowedAmount if possible");
      expect(stabilityPoolNew.totalStakedRaw).to.equal(stabilityPoolPrevious.totalStakedRaw - stableBaseCDPPrevious.totalDebt, "stabilityPool.totalStakedRaw should be decreased by borrowedAmount if possible");
    } else {
      expect(stableBaseCDPNew.cumulativeCollateralPerUnitCollateral).to.not.equal(stableBaseCDPPrevious.cumulativeCollateralPerUnitCollateral, "cumulativeCollateralPerUnitCollateral should be increased.");
      expect(stableBaseCDPNew.cumulativeDebtPerUnitCollateral).to.not.equal(stableBaseCDPPrevious.cumulativeDebtPerUnitCollateral, "cumulativeDebtPerUnitCollateral should be increased.");
    }

    // Check owners, balances and tokenApprovals of the NFT
    const previousOwner = (previousSnapshot.contractSnapshot.stableBaseCDP as any).tokenOwner;
    const newOwner = (newSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot).tokenOwner;
    expect(newOwner).to.equal(ethers.ZeroAddress, 'tokenOwner must be the zero address');

    const previousBalance = previousSnapshot.accountSnapshot[context.contracts.stableBaseCDP.target] || BigInt(0);
    const newBalance = newSnapshot.accountSnapshot[context.contracts.stableBaseCDP.target] || BigInt(0);

    //Eth balance of contract must change
    expect(newBalance).to.not.equal(previousBalance, 'The balance of the contract must change');

    const actorPreviousBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const actorNewBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    expect(actorNewBalance).to.be.gte(actorPreviousBalance, 'The actor balance must increase due to gas compensation');


    const previousApproval = (previousSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot).approvedAddress;
    const newApproval = (newSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot).approvedAddress;
    expect(newApproval).to.equal(ethers.ZeroAddress, 'tokenApproval must be zeroed');

    return true;
  }
}
