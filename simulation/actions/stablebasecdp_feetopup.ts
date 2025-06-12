import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class FeeTopupAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("FeeTopupAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const safeOwners = currentSnapshot.contractSnapshot.stableBaseCDP.safeOwners;
    const safeIds = Object.keys(safeOwners).map(Number).filter(safeId => safeOwners[safeId] === actor.account.address);

    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    const safeId = safeIds[Math.floor(context.prng.next() % safeIds.length)];
    const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safesData[safeId];

    if (!safe) {
      return [false, {}, {}];
    }

    const topupRateBound = 1000;
    const topupRate = BigInt(Math.floor(context.prng.next() % topupRateBound) + 1); // Non-zero topupRate
    const nearestSpotInRedemptionQueue = BigInt(0);

    const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
    const senderBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    const fee = (topupRate * safe.borrowedAmount) / BigInt(10000);

    if (senderBalance < fee) {
      return [false, {}, {}];
    }

    const actionParams = {
      safeId: BigInt(safeId),
      topupRate: topupRate,
      nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { safeId, topupRate, nearestSpotInRedemptionQueue } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .feeTopup(safeId, topupRate, nearestSpotInRedemptionQueue);
    const receipt = await tx.wait();
    return { receipt };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { safeId, topupRate, nearestSpotInRedemptionQueue } = actionParams;
    const safeIdNumber = Number(safeId);

    const previousSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safesData[safeIdNumber];
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safesData[safeIdNumber];
    const previousTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    const newTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    const previousTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const previousDFIDTokenBalance = previousSnapshot.contractSnapshot.dfidToken.balances[(context.contracts.stableBaseCDP as ethers.Contract).target] || BigInt(0);
    const newDFIDTokenBalance = newSnapshot.contractSnapshot.dfidToken.balances[(context.contracts.stableBaseCDP as ethers.Contract).target] || BigInt(0);
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    if (!previousSafe || !newSafe) {
      console.log("Safe not found in snapshot");
      return false;
    }

    const fee = (topupRate * previousSafe.borrowedAmount) / BigInt(10000);

    let refundFee = BigInt(0);
    const logs = executionReceipt.receipt.logs;
    for (const log of logs) {
        if (log.address === (context.contracts.stableBaseCDP as ethers.Contract).target) {
            let parsedLog = null
            try {
              parsedLog = this.contract.interface.parseLog(log);
            } catch(e) {
              continue;
            }
            if (parsedLog && parsedLog.name === "FeeRefund") {
                refundFee = parsedLog.args.refund;
                break;
            }
        }
    }
    
    expect(newSafe.weight).to.equal(previousSafe.weight + topupRate, "Safe weight should be increased by topupRate");
    expect(newSafe.feePaid).to.equal(previousSafe.feePaid + fee - refundFee, "Safe feePaid should be increased by the calculated fee amount, accounting for refunds");
    expect(newDFIDTokenBalance).to.equal(previousDFIDTokenBalance + fee - refundFee, "Contract's SBD token balance should increase by the fee amount minus refund");
    expect(newAccountBalance).to.equal(previousAccountBalance - fee + refundFee, "Message sender's SBD token balance should decrease by the fee amount plus refund");

    // Redemption Queue Validation (Simplified - more detailed validation might require access to the linked list contract)
    const newRedemptionQueue = newSnapshot.contractSnapshot.safesOrderedForRedemption.nodes;
    expect(newRedemptionQueue[safeId].value).to.equal(newSafe.weight, "Redemption queue should contain the safe with updated weight");

    // Total Debt and Collateral Validation (Conditional updates based on cumulative values)
     if (
            previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral !=
            newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral
        ) {
      
        const collateralIncrease = (previousSafe.collateralAmount *
                (newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral -
                    previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshotsData[safeIdNumber].collateralPerCollateralSnapshot)) /
                BigInt(10 ** 18);

         const debtIncrease = (previousSafe.collateralAmount *
                (newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral -
                    previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshotsData[safeIdNumber].debtPerCollateralSnapshot)) /
             BigInt(10 ** 18);


        expect(newTotalCollateral).to.equal(previousTotalCollateral + collateralIncrease, "Total collateral should be updated");
        expect(newTotalDebt).to.equal(previousTotalDebt + debtIncrease, "Total debt should be updated");

          const previousLiquidationSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshotsData[safeIdNumber];
          const newLiquidationSnapshot = newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshotsData[safeIdNumber];

            expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + debtIncrease, "borrowedAmount should be updated.");
            expect(newSafe.collateralAmount).to.equal(previousSafe.collateralAmount + collateralIncrease, "collateralAmount should be updated.");
          expect(newLiquidationSnapshot.debtPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral, "debtPerCollateralSnapshot should be updated");
          expect(newLiquidationSnapshot.collateralPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral, "collateralPerCollateralSnapshot should be updated");

    }
    else {
      expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount, "borrowedAmount should not be updated.");
      expect(newSafe.collateralAmount).to.equal(previousSafe.collateralAmount, "collateralAmount should not be updated.");
    }

    return true;
  }
}
