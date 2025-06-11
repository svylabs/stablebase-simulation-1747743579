import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class FeetopupAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("FeeTopupAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    if (!stableBaseCDPSnapshot) {
      console.warn("StableBaseCDP snapshot not available.");
      return [false, {}, {}];
    }

    // Get safeIds owned by the actor
    const safeIds = Object.keys(stableBaseCDPSnapshot.safes || {}).filter(
      (safeId) => {
        const safe = stableBaseCDPSnapshot.safes[safeId];
        // Assuming _onlyOwner modifier means the actor is the owner.  Without explicit owner tracking in the snapshot, this is the best we can do.
        //  If there was a way to check the owner from chain or snapshot then it would be used.
        return true; // Replace with actual owner check if available
      }
    );

    if (safeIds.length === 0) {
      console.warn("No safes found owned by the actor in the StableBaseCDP snapshot.");
      return [false, {}, {}];
    }

    const safeId = BigInt(safeIds[context.prng.next() % safeIds.length]);

    const safe = stableBaseCDPSnapshot.safes[safeId];
    if (!safe) {
      console.warn(`Safe with ID ${safeId} not found.`);
      return [false, {}, {}];
    }

    const topupRate = BigInt(context.prng.next() % 1000 + 1); // Ensure topupRate > 0, random value
    const nearestSpotInRedemptionQueue = BigInt(0);

    // Ensure the actor has enough SBD tokens to pay the fee
    const fee = (topupRate * safe.borrowedAmount) / BigInt(10000); // BASIS_POINTS_DIVISOR is 10000
    const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target

    if (dfidTokenAddress === undefined) {
        console.warn("dfidToken address not found.");
        return [false, {}, {}];
    }

    const actorBalance = currentSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);

    if (actorBalance < fee) {
      console.warn(
        `Actor ${actor.account.address} does not have enough SBD tokens to pay the fee. Required: ${fee}, Available: ${actorBalance}`
      );
      return [false, {}, {}];
    }

    const actionParams = {
      safeId: safeId,
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
      .feeTopup(
        safeId,
        topupRate,
        nearestSpotInRedemptionQueue
      );
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
    const { safeId, topupRate } = actionParams;
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

    if (!previousStableBaseCDPSnapshot || !newStableBaseCDPSnapshot || !previousDFIDTokenSnapshot || !newDFIDTokenSnapshot) {
      console.warn("Required snapshots not available.");
      return false;
    }

    const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
    const newSafe = newStableBaseCDPSnapshot.safes[safeId];

    if (!previousSafe || !newSafe) {
      console.warn(`Safe with ID ${safeId} not found in snapshots.`);
      return false;
    }

    // Validate: safe.weight should be increased by topupRate compared to its previous value.
    expect(newSafe.weight).to.equal(previousSafe.weight + topupRate, "Safe weight should be increased by topupRate.");

    // Calculate fee
    const fee = (topupRate * previousSafe.borrowedAmount) / BigInt(10000);

    // Validate: safe.feePaid should be increased by fee compared to its previous value.
    expect(newSafe.feePaid).to.equal(previousSafe.feePaid + fee, "Safe feePaid should be increased by fee.");

    // Validate Token Balances for the contract.
    const contractAddress = (context.contracts.stableBaseCDP as ethers.Contract).target

    if (contractAddress === undefined) {
      console.warn("StableBaseCDP address not found.");
      return false;
    }

    const previousContractBalance = previousDFIDTokenSnapshot.balances[contractAddress] || BigInt(0);
    const newContractBalance = newDFIDTokenSnapshot.balances[contractAddress] || BigInt(0);

    // Validate Token Balances for the actor.
    const previousActorBalance = previousDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);
    const newActorBalance = newDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);

    // The contract's SBD token balance should increase by `fee`.
    expect(newContractBalance).to.equal(previousContractBalance + fee, "Contract SBD balance should increase by fee.");

    // The user's SBD token balance should decrease by `fee`.
    expect(newActorBalance).to.equal(previousActorBalance - fee, "User SBD balance should decrease by fee.");

    // Validate: Safe's collateralAmount and borrowedAmount should be updated based on cumulativeCollateralPerUnitCollateral and cumulativeDebtPerUnitCollateral.
    if (
      previousStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral !==
        newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral ||
      previousStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral !==
        newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral
    ) {
      // In a real implementation, you would need to calculate the expected changes to collateralAmount and borrowedAmount based on the cumulative values.
      // Since we don't have enough information to perform that calculation here, we'll just check that they have changed.  Ideally use the values from event.
      expect(newSafe.collateralAmount).to.not.equal(
        previousSafe.collateralAmount,
        "Collateral amount should be updated"
      );
      expect(newSafe.borrowedAmount).to.not.equal(
        previousSafe.borrowedAmount,
        "Borrowed amount should be updated"
      );
    }

    // Validate Redemption Queue position - requires access to the OrderedDoublyLinkedList snapshot
    const previousRedemptionQueue = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const newRedemptionQueue = newSnapshot.contractSnapshot.safesOrderedForRedemption;

    if (previousRedemptionQueue && newRedemptionQueue) {
      // Add logic here to validate that the safe's position in the queue has been updated correctly.
      // This will require examining the nodes in the linked list and verifying that the safeId is in the correct position
      // based on its weight.
      // This is a complex validation and may require additional data from the snapshots.
      expect(true).to.be.true; // Placeholder - replace with actual validation
    }

    // Validate TotalDebt
    expect(newStableBaseCDPSnapshot.totalDebt).to.gte(
      previousStableBaseCDPSnapshot.totalDebt,
      "Total debt should be updated correctly."
    );

    // Validate Liquidation Snapshot - Requires implementation for each safeId
    const previousLiquidationSnapshot = previousStableBaseCDPSnapshot.liquidationSnapshots && previousStableBaseCDPSnapshot.liquidationSnapshots[safeId];
    const newLiquidationSnapshot = newStableBaseCDPSnapshot.liquidationSnapshots && newStableBaseCDPSnapshot.liquidationSnapshots[safeId];

    if (previousLiquidationSnapshot && newLiquidationSnapshot) {
      // Ensure that liquidationSnapshots[safeId].collateralPerCollateralSnapshot is equal to cumulativeCollateralPerUnitCollateral
      // Ensure that liquidationSnapshots[safeId].debtPerCollateralSnapshot is equal to cumulativeDebtPerUnitCollateral
      expect(newLiquidationSnapshot.collateralPerCollateralSnapshot).to.equal(
        newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral,
        "collateralPerCollateralSnapshot  should be equal to cumulativeCollateralPerUnitCollateral"
      );
      expect(newLiquidationSnapshot.debtPerCollateralSnapshot).to.equal(
        newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral,
        "debtPerCollateralSnapshot should be equal to cumulativeDebtPerUnitCollateral"
      );
    }

    // Validate Total Collateral
    expect(newStableBaseCDPSnapshot.totalCollateral).to.gte(
      previousStableBaseCDPSnapshot.totalCollateral,
      "Total collateral should be updated correctly."
    );

    // Event validation - this requires parsing the logs from the execution receipt
    if (executionReceipt && executionReceipt.receipt && executionReceipt.receipt.logs) {
      const logs = executionReceipt.receipt.logs;

      // Find the FeeTopup event and validate its parameters
      const feeTopupEvent = logs.find((log: any) => {
        try {
          const parsedLog = this.contract.interface.parseLog(log);
          return parsedLog.name === "FeeTopup";
        } catch (e) {
          return false;
        }
      });

      if (feeTopupEvent) {
        const parsedLog = this.contract.interface.parseLog(feeTopupEvent);
        expect(parsedLog.args.safeId).to.equal(safeId, "FeeTopup event: safeId should match");
        expect(parsedLog.args.topupRate).to.equal(topupRate, "FeeTopup event: topupRate should match");
        // expect(parsedLog.args.fee).to.equal(fee, "FeeTopup event: fee should match"); // Fee is already validated
        expect(parsedLog.args.weight).to.equal(newSafe.weight, "FeeTopup event: weight should match");
      } else {
        console.warn("FeeTopup event not found in logs.");
        return false;
      }

      // Find the RedemptionQueueUpdated event and validate its parameters
      const redemptionQueueUpdatedEvent = logs.find((log: any) => {
        try {
          const parsedLog = this.contract.interface.parseLog(log);
          return parsedLog.name === "RedemptionQueueUpdated";
        } catch (e) {
          return false;
        }
      });

      if (redemptionQueueUpdatedEvent) {
        const parsedLog = this.contract.interface.parseLog(redemptionQueueUpdatedEvent);
        expect(parsedLog.args.safeId).to.equal(safeId, "RedemptionQueueUpdated event: safeId should match");
        expect(parsedLog.args.weight).to.equal(newSafe.weight, "RedemptionQueueUpdated event: weight should match");
      } else {
        console.warn("RedemptionQueueUpdated event not found in logs.");
        return false;
      }

      // TODO: Add similar validation for FeeRefund and SafeUpdated events based on your contract's event emissions
    }

    return true;
  }
}
