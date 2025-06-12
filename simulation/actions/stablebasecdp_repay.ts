import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

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
    const accountAddress = actor.account.address;

    let safeId: number | null = null;
    for (const id in stableBaseCDPSnapshot.safeOwners) {
      if (stableBaseCDPSnapshot.safeOwners[id] === accountAddress) {
        safeId = parseInt(id, 10);
        break;
      }
    }

    if (safeId === null) {
      console.log("No safe found for this account.");
      return [false, {}, {}];
    }

    const safe = stableBaseCDPSnapshot.safesData[safeId];
    if (!safe || safe.borrowedAmount === BigInt(0)) {
      console.log("No borrowed amount to repay for this safe.");
      return [false, {}, {}];
    }

    const accountSBDBalance = dfidTokenSnapshot.balances[accountAddress] || BigInt(0);
    if (accountSBDBalance === BigInt(0)) {
      console.log("Account has no SBD to repay");
      return [false, {}, {}];
    }

    let amount =  (safe.borrowedAmount < accountSBDBalance ? safe.borrowedAmount : accountSBDBalance);

    if (amount <= BigInt(0)) {
      console.log("Amount is zero or less than zero.");
      return [false, {}, {}];
    }

    // Find a valid nearestSpotInLiquidationQueue. It can be 0 also.
    let nearestSpotInLiquidationQueue = BigInt(0);
    const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;
    if (safesOrderedForLiquidationSnapshot.headId !== BigInt(0)) {
      let currentId = safesOrderedForLiquidationSnapshot.headId;
      let closestNodeId = BigInt(0);
      let minDifference = BigInt(2**256 - 1);

      while (currentId !== BigInt(0)) {
        const currentNode = safesOrderedForLiquidationSnapshot.nodes[currentId];
        if(!currentNode) {
          currentId = safesOrderedForLiquidationSnapshot.headId;
          continue;
        }

        const currentNodeValue = currentNode.value;
        const difference = safe.borrowedAmount > currentNodeValue ? safe.borrowedAmount - currentNodeValue : currentNodeValue - safe.borrowedAmount;
        if (difference < minDifference) {
          minDifference = difference;
          closestNodeId = currentId;
        }
        currentId = safesOrderedForLiquidationSnapshot.nodes[currentId].next || BigInt(0);
      }
      nearestSpotInLiquidationQueue = closestNodeId;
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
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract
      .connect(actor.account.value)
      .repay(
        actionParams.safeId,
        actionParams.amount,
        actionParams.nearestSpotInLiquidationQueue
      );
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
    const safeId = actionParams.safeId;
    const amount = actionParams.amount;

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

    const previousSafe = previousStableBaseCDPSnapshot.safesData[safeId];
    const newSafe = newStableBaseCDPSnapshot.safesData[safeId];

    const initialBorrowedAmount = previousSafe.borrowedAmount;

    // Validate safes[safeId].borrowedAmount
    let expectedBorrowedAmount = initialBorrowedAmount - amount;

    const liquidationSnapshotBefore = previousStableBaseCDPSnapshot.liquidationSnapshotsData[safeId];
    const liquidationSnapshotAfter = newStableBaseCDPSnapshot.liquidationSnapshotsData[safeId];

    let debtIncrease = BigInt(0);
    if (
      liquidationSnapshotBefore.collateralPerCollateralSnapshot !=
      newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral
    ) {
      debtIncrease = (previousSafe.collateralAmount *
        (newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral -
          liquidationSnapshotBefore.debtPerCollateralSnapshot)) / BigInt(10 ** 18);
      expectedBorrowedAmount += debtIncrease;
    }

    expect(newSafe.borrowedAmount).to.equal(expectedBorrowedAmount, "safes[safeId].borrowedAmount should be equal to the initial borrowedAmount minus the repayment amount and potential debt increase/decrease from the _updateSafe function call");

    if (newSafe.borrowedAmount > BigInt(0)) {
      expect(newSafe.borrowedAmount).to.be.gte(BigInt(2000) * BigInt(10) ** BigInt(18), "If safes[safeId].borrowedAmount is greater than 0, then safes[safeId].borrowedAmount >= MINIMUM_DEBT.");
    } else {
      const safesOrderedForLiquidation = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
      const safesOrderedForRedemption = newSnapshot.contractSnapshot.safesOrderedForRedemption;
      expect(safesOrderedForLiquidation.nodes[safeId]?.value).to.equal(undefined, "The safe should be removed from the liquidation queue.");
      expect(safesOrderedForRedemption.nodes[safeId]?.value).to.equal(undefined, "The safe should be removed from the redemption queues.");
    }

    // Validate sbdToken.balanceOf(msg.sender)
    const previousAccountBalance = previousDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);
    const newAccountBalance = newDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);

    expect(newAccountBalance).to.equal(previousAccountBalance - amount, "sbdToken.balanceOf(msg.sender) should be decreased by the amount repaid.");

    // Validate totalDebt
    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;
    let expectedTotalDebt = previousTotalDebt - amount;

    expectedTotalDebt += debtIncrease;

    expect(newTotalDebt).to.equal(expectedTotalDebt, "totalDebt should be decreased by the amount repaid and any changes that occur during the updateSafe function call.");

    //Validate protocol mode
    if (
      newTotalDebt > BigInt(5000000) * BigInt(10) ** BigInt(18) &&
      previousStableBaseCDPSnapshot.protocolMode == 0
    ) {
      expect(newStableBaseCDPSnapshot.protocolMode).to.equal(1, "If the totalDebt is greater than BOOTSTRAP_MODE_DEBT_THRESHOLD, and the protocol mode was BOOTSTRAP then PROTOCOL_MODE should be NORMAL.");
    }

    // Validate Liquidation Queue updates
    const previousLiquidationQueue = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes;
    const newLiquidationQueue = newSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes;

    const newRatio = (newSafe.borrowedAmount * BigInt(10 ** 18)) / newSafe.collateralAmount;

    if (newRatio !== BigInt(0)) {
      // Safe should be in liquidation queue
      expect(newLiquidationQueue[safeId]).to.not.be.undefined;
      // Weight should be updated
      expect(newLiquidationQueue[safeId].value).to.equal(newRatio);
    } else {
      // Safe should be removed from liquidation queue
      expect(newLiquidationQueue[safeId]).to.be.undefined;
    }

    // Event Emission Validation
    const repaidEvent = executionReceipt.receipt.logs.find(
      (log) =>
        log.address === this.contract.target &&
        this.contract.interface.parseLog(log)?.name === "Repaid"
    );

    expect(repaidEvent).to.not.be.undefined;

    if (repaidEvent) {
      const parsedLog = this.contract.interface.parseLog(repaidEvent);
      expect(parsedLog.args.safeId).to.equal(BigInt(safeId));
      expect(parsedLog.args.amount).to.equal(amount);
      expect(parsedLog.args.newRatio).to.equal(newRatio);
      expect(parsedLog.args.totalCollateral).to.equal(newStableBaseCDPSnapshot.totalCollateral);
      expect(parsedLog.args.totalDebt).to.equal(newStableBaseCDPSnapshot.totalDebt);
    }

    return true;
  }
}
