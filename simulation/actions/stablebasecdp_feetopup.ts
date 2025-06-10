import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
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
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP as any;

    const safeIds = Object.keys(stableBaseCDPSnapshot.safeInfo || {});
    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    const safeId = safeIds[context.prng.next() % safeIds.length];
    const safe = stableBaseCDPSnapshot.safeInfo[safeId];

    // Bound topupRate based on borrowedAmount.  Avoid large values.
    const maxTopupRate = safe.borrowedAmount / BigInt(100); // Example: max 1% of borrowedAmount
    const topupRate = BigInt(context.prng.next() % Number(maxTopupRate) + 1); // Ensure topupRate > 0

    //Nearest Spot can be 0 or 1 in this case.
    const nearestSpotInRedemptionQueue = BigInt(context.prng.next() % 2);

    //Check balance of the actor to see if its sufficient to do the feeTopup.
    const fee = (topupRate * safe.borrowedAmount) / BigInt(10000);
    const actorBalance = currentSnapshot.accountSnapshot[actor.account.address];
    if (actorBalance === undefined || actorBalance < fee) {
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
  ): Promise<Record<string, any> | void> {
    return this.contract
      .connect(actor.account.value)
      .feeTopup(
        actionParams.safeId,
        actionParams.topupRate,
        actionParams.nearestSpotInRedemptionQueue
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
    const stableBaseCDPPreviousSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP as any;
    const stableBaseCDPNewSnapshot = newSnapshot.contractSnapshot.stableBaseCDP as any;
    const dfidTokenPreviousSnapshot = previousSnapshot.contractSnapshot.dfidToken as any;
    const dfidTokenNewSnapshot = newSnapshot.contractSnapshot.dfidToken as any;

    const safeId = actionParams.safeId;
    const topupRate = actionParams.topupRate;

    const previousSafe = stableBaseCDPPreviousSnapshot.safeInfo[safeId];
    const newSafe = stableBaseCDPNewSnapshot.safeInfo[safeId];

    const fee = (topupRate * previousSafe.borrowedAmount) / BigInt(10000);

    // Safe State validations
    expect(newSafe.weight, `Safe's weight should be increased by topupRate for safeId: ${safeId}`).to.equal(previousSafe.weight + topupRate);
    expect(newSafe.feePaid, `Safe's feePaid should be increased by the fee amount for safeId: ${safeId}`).to.equal(previousSafe.feePaid + fee);

    // Token balance validations
    const actorPreviousBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const actorNewBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    const feeRefundEvent = executionReceipt.events?.find((event) => event.event === "FeeRefund")?.args;
    const refundFee = BigInt(feeRefundEvent?.refund || 0);
    const feeDistributedEvent = executionReceipt.events?.find((event) => event.event === "FeeDistributed")?.args;
    const feePaid = BigInt(feeDistributedEvent?.feePaid || 0);

    expect(actorNewBalance, `SBD token balance of msg.sender should decrease by fee - refundFee for safeId: ${safeId}`).to.equal(actorPreviousBalance - fee + refundFee);

    const contractPreviousBalance = dfidTokenPreviousSnapshot.balance || BigInt(0);
    const contractNewBalance = dfidTokenNewSnapshot.balance || BigInt(0);
    const mint = feeDistributedEvent?.mint;
    if (mint) {
      expect(contractNewBalance, `Contract's SBD token balance should increase by fee amount for safeId: ${safeId}`).to.equal(contractPreviousBalance + feePaid - refundFee);
    } else {
      expect(contractNewBalance, `Contract's SBD token balance should decrease by refund amount for safeId: ${safeId}`).to.equal(contractPreviousBalance - refundFee);
    }

    // Event validations
    const feeTopupEvent = executionReceipt.events?.find((event) => event.event === "FeeTopup")?.args;
    expect(feeTopupEvent?.safeId, `FeeTopup event should have the correct safeId for safeId: ${safeId}`).to.equal(safeId);
    expect(feeTopupEvent?.topupRate, `FeeTopup event should have the correct topupRate for safeId: ${safeId}`).to.equal(topupRate);
    expect(feeTopupEvent?.feePaid, `FeeTopup event should have the correct feePaid for safeId: ${safeId}`).to.equal(fee);
    expect(feeTopupEvent?.newWeight, `FeeTopup event should have the correct newWeight for safeId: ${safeId}`).to.equal(newSafe.weight);

    const redemptionQueueUpdatedEvent = executionReceipt.events?.find((event) => event.event === "RedemptionQueueUpdated")?.args;
    expect(redemptionQueueUpdatedEvent?.safeId, `RedemptionQueueUpdated event should have the correct safeId for safeId: ${safeId}`).to.equal(safeId);
    expect(redemptionQueueUpdatedEvent?.newWeight, `RedemptionQueueUpdated event should have the correct newWeight for safeId: ${safeId}`).to.equal(newSafe.weight);

    if (feeRefundEvent) {
      expect(feeRefundEvent.safeId, `FeeRefund event should have the correct safeId for safeId: ${safeId}`).to.equal(safeId);
      expect(feeRefundEvent.refund, `FeeRefund event should have the correct refund amount for safeId: ${safeId}`).to.equal(refundFee);
    }

    const feeDistributedEventEmitted = executionReceipt.events?.find((event) => event.event === "FeeDistributed")?.args;
    expect(feeDistributedEventEmitted?.safeId, `FeeDistributed event should have the correct safeId for safeId: ${safeId}`).to.equal(safeId);

    // Check for SafeUpdated event and validate parameters
    const safeUpdatedEvent = executionReceipt.events?.find((event) => event.event === "SafeUpdated")?.args;

    if (safeUpdatedEvent) {
      expect(safeUpdatedEvent.safeId, `SafeUpdated event should have the correct safeId for safeId: ${safeId}`).to.equal(safeId);

      const collateralIncrease = safeUpdatedEvent.collateralIncrease
      const debtIncrease = safeUpdatedEvent.debtIncrease

      expect(stableBaseCDPNewSnapshot.totalCollateral, `totalCollateral must have increased. safeId: ${safeId}`).to.equal(stableBaseCDPPreviousSnapshot.totalCollateral + collateralIncrease)
      expect(stableBaseCDPNewSnapshot.totalDebt, `totalDebt must have increased. safeId: ${safeId}`).to.equal(stableBaseCDPPreviousSnapshot.totalDebt + debtIncrease)
    }

    // Validate totalCollateral and totalDebt updates if cumulative values changed
    if (stableBaseCDPPreviousSnapshot.cumulativeCollateralPerUnitCollateral != stableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral) {
      expect(stableBaseCDPNewSnapshot.totalCollateral, `Total collateral should be updated for safeId: ${safeId}`).to.not.equal(stableBaseCDPPreviousSnapshot.totalCollateral);
      expect(stableBaseCDPNewSnapshot.totalDebt, `Total debt should be updated for safeId: ${safeId}`).to.not.equal(stableBaseCDPPreviousSnapshot.totalDebt);
    }

    return true;
  }
}
