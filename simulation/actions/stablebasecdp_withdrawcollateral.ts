import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
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
    if (!stableBaseCDPSnapshot) {
      console.warn("StableBaseCDP snapshot not found, can't initialize WithdrawCollateralAction");
      return [false, {}, {}];
    }

    let safeId: bigint | null = null;
    let safeOwner: string | undefined = undefined;

    if (stableBaseCDPSnapshot.safeInfo) {
      for (const id in stableBaseCDPSnapshot.safeInfo) {
        safeId = BigInt(id);
        break;
      }
    }

    if (safeId === null) {
      console.warn("No safes found, can't withdraw collateral.");
      return [false, {}, {}];
    }

    //Need to fetch owner by calling contract
    try {
      safeOwner = await this.contract.ownerOf(safeId);
    } catch (error) {
      console.warn("Failed to fetch safe owner:", error);
      return [false, {}, {}];
    }

    if (safeOwner !== actor.account.address) {
      console.warn("Actor is not the owner of the safe.");
      return [false, {}, {}];
    }

    const collateralAmount = stableBaseCDPSnapshot.safeInfo[safeId.toString()].collateralAmount;

    //Check collateral amount before proceeding
    if (collateralAmount <= BigInt(0)) {
      console.warn("No collateral to withdraw from the safe.");
      return [false, {}, {}];
    }

    const maxWithdrawalAmount = collateralAmount;
    const amount = BigInt(context.prng.next()) % (maxWithdrawalAmount > BigInt(100) ? BigInt(100) : maxWithdrawalAmount);

    if (amount <= BigInt(0)) {
      console.warn("Withdrawal amount is zero, skipping.");
      return [false, {}, {}];
    }

    const nearestSpotInLiquidationQueue = BigInt(context.prng.next()) % BigInt(100);

    const params = {
      safeId: safeId,
      amount: amount,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
    };

    return [true, params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;

    try {
      const tx = await this.contract
        .connect(actor.account.value)
        .withdrawCollateral(
          safeId,
          amount,
          nearestSpotInLiquidationQueue
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
    const { safeId, amount } = actionParams;
    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;

    if (!stableBaseCDPPrevious || !stableBaseCDPNew) {
      console.warn("StableBaseCDP snapshot not found, can't validate WithdrawCollateralAction");
      return false;
    }

    // Validate collateral amount
    const initialCollateralAmount = stableBaseCDPPrevious.safeInfo[safeId.toString()].collateralAmount;
    const newCollateralAmount = stableBaseCDPNew.safeInfo[safeId.toString()].collateralAmount;
    const expectedCollateralAmount = initialCollateralAmount - amount;

    expect(newCollateralAmount).to.be.eq(expectedCollateralAmount, "Collateral amount should decrease correctly");

    // Validate total collateral
    const initialTotalCollateral = stableBaseCDPPrevious.totalCollateral;
    const newTotalCollateral = stableBaseCDPNew.totalCollateral;
    const expectedTotalCollateral = initialTotalCollateral - amount;

    expect(newTotalCollateral).to.be.eq(expectedTotalCollateral, "Total collateral should decrease correctly");

    // Validate actor's ETH balance increase
    const actorAddress = actor.account.address;
    const previousBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    const newBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);

    expect(newBalance).to.be.gte(previousBalance + amount, "Actor's ETH balance should increase by the withdrawn amount");

    // Validate WithdrawnCollateral event
    const withdrawnCollateralEvent = executionReceipt?.events?.find(
      (event: any) => event.event === 'WithdrawnCollateral'
    );

    expect(withdrawnCollateralEvent?.args?.safeId).to.eq(safeId, "Incorrect safeId in WithdrawnCollateral event");
    expect(withdrawnCollateralEvent?.args?.amount).to.eq(amount, "Incorrect amount in WithdrawnCollateral event");
    expect(withdrawnCollateralEvent?.args?.totalCollateral).to.eq(newTotalCollateral, "Incorrect totalCollateral in WithdrawnCollateral event");
    expect(withdrawnCollateralEvent?.args?.totalDebt).to.eq(stableBaseCDPNew.totalDebt, "Incorrect totalDebt in WithdrawnCollateral event");

    // Validate LiquidationQueueUpdated event
    const liquidationQueueUpdatedEvent = executionReceipt?.events?.find(
      (event: any) => event.event === 'LiquidationQueueUpdated'
    );

    //Additional checks can be added here based on contract logic.

    return true;
  }
}
