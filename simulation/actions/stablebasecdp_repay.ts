import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class RepayAction extends Action {
  private contract: ethers.Contract;
  private dfidTokenContract: ethers.Contract;
  private safesOrderedForLiquidationContract: ethers.Contract;

  constructor(
    contract: ethers.Contract,
    dfidTokenContract: ethers.Contract,
    safesOrderedForLiquidationContract: ethers.Contract
  ) {
    super("RepayAction");
    this.contract = contract;
    this.dfidTokenContract = dfidTokenContract;
    this.safesOrderedForLiquidationContract = safesOrderedForLiquidationContract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;

    // Find a safe belonging to the actor
    let safeId: string | undefined;
    for (const id in stableBaseCDPSnapshot.safes) {
      if (stableBaseCDPSnapshot.safeOwners[parseInt(id)] === actor.account.address) {
        safeId = id;
        break;
      }
    }

    if (!safeId) {
      console.log("No safes found for this actor");
      return [false, [], {}];
    }

    const safe = stableBaseCDPSnapshot.safes[safeId];

    if (!safe) {
      console.log(`Safe with ID ${safeId} not found.`);
      return [false, [], {}];
    }

    const borrowedAmount = safe.borrowedAmount;
    if (borrowedAmount <= BigInt(0)) {
      console.log("No borrowed amount to repay");
      return [false, [], {}];
    }

    const accountAddress = actor.account.address;
    const sbdTokenBalance = dfidTokenSnapshot.balances[accountAddress] || BigInt(0);

    if (sbdTokenBalance <= BigInt(0)) {
      console.log("Insufficient SBD balance to repay");
      return [false, [], {}];
    }

    const maxRepayAmount = borrowedAmount < sbdTokenBalance ? borrowedAmount : sbdTokenBalance;
    // Ensure amount is between 1 and maxRepayAmount
    const amount = BigInt(Math.floor(context.prng.next() % Number(maxRepayAmount) + 1));

    if (amount <= BigInt(0) || amount > borrowedAmount) {
      console.log("Repayment amount is invalid");
      return [false, [], {}];
    }

    const remainingDebt = borrowedAmount - amount;
    const minimumDebt = stableBaseCDPSnapshot.minimumDebt;
    if (remainingDebt !== BigInt(0) && remainingDebt < minimumDebt) {
      console.log("Invalid repayment amount due to minimum debt");
      return [false, [], {}];
    }

    // nearestSpotInLiquidationQueue can be 0 if unknown.
    const nearestSpotInLiquidationQueue = BigInt(0);

    const actionParams = {
      safeId: BigInt(safeId),
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
    const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;
    const tx = await this.contract
      .connect(actor.account.value)
      .repay(safeId, amount, nearestSpotInLiquidationQueue);

    return { receipt: await tx.wait(), additionalInfo: {} };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { safeId, amount } = actionParams;

    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const previousSafe = stableBaseCDPPrevious.safes[safeId];
    const newSafe = stableBaseCDPNew.safes[safeId];

    const initialBorrowedAmount = previousSafe.borrowedAmount;
    const finalBorrowedAmount = newSafe.borrowedAmount;

    expect(finalBorrowedAmount).to.equal(initialBorrowedAmount - amount, "Borrowed amount should be decreased by amount");
    expect(finalBorrowedAmount).to.be.at.least(BigInt(0), "Borrowed amount should be greater than or equal to 0");

    const previousTotalDebt = stableBaseCDPPrevious.totalDebt;
    const newTotalDebt = stableBaseCDPNew.totalDebt;

    expect(newTotalDebt).to.equal(previousTotalDebt - amount, "Total debt should be decreased by amount");

    const accountAddress = actor.account.address;
    const previousBalance = dfidTokenPrevious.balances[accountAddress] || BigInt(0);
    const newBalance = dfidTokenNew.balances[accountAddress] || BigInt(0);

    expect(newBalance).to.equal(previousBalance - amount, "SBD token balance should be decreased by the amount repaid");

    const previousTotalSupply = dfidTokenPrevious.totalSupply;
    const newTotalSupply = dfidTokenNew.totalSupply;

    expect(newTotalSupply).to.equal(previousTotalSupply - amount, "Total supply of SBD tokens should be decreased by the amount repaid");

    const repaidEvent = executionReceipt.receipt.logs.find((log: any) => {
      try {
        const parsedLog = this.contract.interface.parseLog(log);
        return parsedLog.name === "Repaid" && parsedLog.args.safeId.toString() === safeId.toString();
      } catch (e) {
        return false;
      }
    });

    expect(repaidEvent).to.not.be.undefined;

    // Validate that the safe is correctly removed from liquidation and redemption queues when borrowedAmount is 0
    if (finalBorrowedAmount === BigInt(0)) {
      const liquidationQueueNode = await this.safesOrderedForLiquidationContract.nodes(safeId);
      expect(liquidationQueueNode.value).to.equal(BigInt(0), "Safe should be removed from liquidation queue");

      // Assuming you also have the safesOrderedForRedemptionContract instance available.  Accessing the contract instance using context
      const safesOrderedForRedemptionContract = context.contracts.safesOrderedForRedemption as ethers.Contract;
      const redemptionQueueNode = await safesOrderedForRedemptionContract.nodes(safeId);
      expect(redemptionQueueNode.value).to.equal(BigInt(0), "Safe should be removed from redemption queue");
    }

    // Validate protocol mode transition from BOOTSTRAP to NORMAL mode based on totalDebt
    if (stableBaseCDPPrevious.mode === 0 && stableBaseCDPNew.mode === 1) {
      expect(previousTotalDebt).to.be.below(stableBaseCDPPrevious.bootstrapModeDebtThreshold, "Previous total debt should be below the threshold");
      expect(newTotalDebt).to.be.at.least(stableBaseCDPPrevious.bootstrapModeDebtThreshold, "New total debt should be at least the threshold");
    }

    // Validate safesOrderedForLiquidation state updates (if newRatio != 0)
    if (finalBorrowedAmount !== BigInt(0)) {
      const newRatio = (finalBorrowedAmount * BigInt(1e18)) / newSafe.collateralAmount; // Assuming PRECISION is 1e18.  Using a constant here, replace with actual precision if different

      const liquidationQueueNode = await this.safesOrderedForLiquidationContract.nodes(safeId);
      expect(liquidationQueueNode.value).to.equal(newRatio, "Liquidation queue should be updated with the new ratio");
    }

    // Validate cumulative collateral and debt per unit collateral updates
    if (
      stableBaseCDPPrevious.liquidationSnapshots[safeId] &&
      stableBaseCDPNew.liquidationSnapshots[safeId] &&
      stableBaseCDPPrevious.liquidationSnapshots[safeId].collateralPerCollateralSnapshot !==
        stableBaseCDPNew.cumulativeCollateralPerUnitCollateral
    ) {
      // Add your validation logic here, e.g.,
      expect(newSafe.collateralAmount).to.not.equal(previousSafe.collateralAmount);
      expect(newSafe.borrowedAmount).to.not.equal(previousSafe.borrowedAmount);
    }

    return true;
  }
}
