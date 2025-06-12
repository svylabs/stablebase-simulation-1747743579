import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class CloseSafeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("CloseSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot: any = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeOwners = stableBaseCDPSnapshot.safeOwners;

    let safeIdToClose: number | null = null;
    for (const safeId in safeOwners) {
      if (safeOwners.hasOwnProperty(safeId)) {
        const owner = safeOwners[safeId];
        if (owner === actor.account.address) {
          const safeData = stableBaseCDPSnapshot.safesData[safeId];
          if (safeData && safeData.borrowedAmount === BigInt(0)) {
            safeIdToClose = parseInt(safeId, 10);
            break;
          }
        }
      }
    }

    if (safeIdToClose === null) {
      return [false, {}, {}];
    }

    const actionParams = {
      safeId: BigInt(safeIdToClose),
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract
      .connect(actor.account.value)
      .closeSafe(actionParams.safeId);
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
    const safeId = Number(actionParams.safeId);
    const previousStableBaseCDPSnapshot: any = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot: any = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousDFIDTokenSnapshot: any = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot: any = newSnapshot.contractSnapshot.dfidToken;

    // Safe State Validation
    expect(
      newStableBaseCDPSnapshot.safesData[safeId],
      "Safe should no longer exist in the safes mapping"
    ).to.be.undefined;
    expect(
      newStableBaseCDPSnapshot.safeOwners[safeId],
      "Safe owner should no longer exist"
    ).to.be.undefined;

    // Token Ownership Validation (ERC721)
    if (previousStableBaseCDPSnapshot.safeOwners[safeId]) {
    const previousSafeOwner = previousStableBaseCDPSnapshot.safeOwners[safeId];
    const newSafeOwner = newStableBaseCDPSnapshot.safeOwners[safeId];
    expect(
      newSafeOwner,
      "The owner of the token ID should be undefined (burned)"
    ).to.be.undefined;

    // ERC721 Balance Validation
    const previousOwnerBalance = previousDFIDTokenSnapshot.balances[previousSafeOwner] || BigInt(0);
    const newOwnerBalance = newDFIDTokenSnapshot.balances[previousSafeOwner] || BigInt(0);
    expect(
      newOwnerBalance,
      "The balance of the previous owner should decrease by 1"
    ).to.equal(previousOwnerBalance - BigInt(1));
    }

    // Global State Validation
    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
    if(previousStableBaseCDPSnapshot.safesData[safeId]){
      const collateralAmount = previousStableBaseCDPSnapshot.safesData[safeId].collateralAmount;
      expect(
        newTotalCollateral,
        "Total collateral should be decreased by the collateralAmount of the closed Safe"
      ).to.equal(previousTotalCollateral - collateralAmount);

      const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
      const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;
      expect(
        newTotalDebt,
        "Total debt should reflect the debt removed from the closed Safe"
      ).to.equal(previousTotalDebt);

      // User Balance Validation
      const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
      const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
      expect(
        newAccountBalance,
        "User balance should increase by the collateralAmount of the closed Safe"
      ).to.equal(previousAccountBalance + collateralAmount);
    }


    //OrderedDoublyLinkedList validation
    const previousSafesOrderedForLiquidation: any = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const newSafesOrderedForLiquidation: any = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    const previousSafesOrderedForRedemption: any = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const newSafesOrderedForRedemption: any = newSnapshot.contractSnapshot.safesOrderedForRedemption;

    if(previousSafesOrderedForLiquidation.nodes[safeId]){
      expect(newSafesOrderedForLiquidation.nodes[safeId], "Safe ID should not exist in liquidation list").to.be.undefined;
    }
    if(previousSafesOrderedForRedemption.nodes[safeId]){
      expect(newSafesOrderedForRedemption.nodes[safeId], "Safe ID should not exist in redemption list").to.be.undefined;
    }

    return true;
  }
}
