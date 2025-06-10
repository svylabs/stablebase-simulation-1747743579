import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class LiquidateSafeAction extends Action {
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
    if (!stableBaseCDPSnapshot) {
      console.log("StableBaseCDP snapshot not found");
      return [false, {}, {}];
    }

    const safeIds = Object.keys(stableBaseCDPSnapshot.safeInfo);
    if (safeIds.length === 0) {
      console.log("No safes found to liquidate");
      return [false, {}, {}];
    }

    // Find a safe to liquidate.
    let safeIdToLiquidate: bigint | null = null;
    for (const safeIdStr of safeIds) {
      const safeId = BigInt(safeIdStr);
      if (stableBaseCDPSnapshot.safeInfo[safeId]) {
        const safeInfo = stableBaseCDPSnapshot.safeInfo[safeId];
        if (safeInfo.collateralAmount > BigInt(0) && safeInfo.borrowedAmount > BigInt(0)) {
          // Additional check: collateralValue < ((borrowedAmount * liquidationRatio) / BASIS_POINTS_DIVISOR)
          // Implement this check using the available snapshot data if liquidationRatio and BASIS_POINTS_DIVISOR are available in the snapshot
          safeIdToLiquidate = safeId;
          break;
        }
      }
    }

    if (safeIdToLiquidate === null) {
      console.log("No suitable safe found for liquidation.");
      return [false, {}, {}];
    }

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
    const safeId = actionParams.safeId;

    try {
      const tx = await this.contract
        .connect(actor.account.value)
        .liquidateSafe(safeId);
      await tx.wait();
    } catch (e) {
      console.log("Error during liquidation execution", e);
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
    const safeId = actionParams.safeId;

    const prevStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    if (!prevStableBaseCDPSnapshot || !newStableBaseCDPSnapshot) {
      console.error("StableBaseCDP snapshot not found");
      return false;
    }

    const prevTotalCollateral = prevStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
    const prevTotalDebt = prevStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    const prevSafeInfo = prevStableBaseCDPSnapshot.safeInfo[safeId];
    const newSafeInfo = newStableBaseCDPSnapshot.safeInfo[safeId];

    if (!prevSafeInfo) {
      console.log("Previous safe info not found");
      return true;
    }

    const prevCollateralAmount = prevSafeInfo.collateralAmount;
    const prevBorrowedAmount = prevSafeInfo.borrowedAmount;

    // safes[safeId] must no longer exist (or must be zeroed)
    expect(newSafeInfo).to.be.undefined;

    // ownerOf(safeId) must return the zero address, indicating the safe's NFT has been burned.
    const nullAddress = ethers.ZeroAddress;
    const stableBaseCDPContract = context.contracts.stableBaseCDP as ethers.Contract;
    const owner = await stableBaseCDPContract._ownerOf(safeId);
    expect(owner).to.equal(nullAddress);

    // totalCollateral must be decreased by the liquidated collateral amount.
    expect(newTotalCollateral).to.equal(prevTotalCollateral - prevCollateralAmount);

    // totalDebt must be decreased by the liquidated borrowed amount.
    expect(newTotalDebt).to.equal(prevTotalDebt - prevBorrowedAmount);

        // OrderedDoublyLinkedList validation
        const prevSafesOrderedForLiquidation = previousSnapshot.contractSnapshot.safesOrderedForLiquidation
        const newSafesOrderedForLiquidation = newSnapshot.contractSnapshot.safesOrderedForLiquidation
        if(prevSafesOrderedForLiquidation && newSafesOrderedForLiquidation){
            const prevNode = prevSafesOrderedForLiquidation.NodeByIdMapping[safeId.toString()];
            if(prevNode) {
                expect(newSafesOrderedForLiquidation.NodeByIdMapping[safeId.toString()]).to.be.undefined;
            }
        }

        const prevSafesOrderedForRedemption = previousSnapshot.contractSnapshot.safesOrderedForRedemption
        const newSafesOrderedForRedemption = newSnapshot.contractSnapshot.safesOrderedForRedemption
        if(prevSafesOrderedForRedemption && newSafesOrderedForRedemption){
            const prevNode = prevSafesOrderedForRedemption.NodeByIdMapping[safeId.toString()];
            if(prevNode) {
                expect(newSafesOrderedForRedemption.NodeByIdMapping[safeId.toString()]).to.be.undefined;
            }
        }

    // Validate token balance changes if needed
    //For ex:
    // const tokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
    // const prevTokenBalance = previousSnapshot.accountSnapshot[tokenAddress] || BigInt(0);
    // const newTokenBalance = newSnapshot.accountSnapshot[tokenAddress] || BigInt(0);
    // expect(newTokenBalance).to.equal(prevTokenBalance - prevBorrowedAmount);

    return true;
  }
}
