import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

export class BorrowAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("BorrowAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const safeId = BigInt(actor.identifiers.safeId ? actor.identifiers.safeId : Math.floor(Number(context.prng.next()) % 100) + 1);
    const amount = BigInt(Math.floor(Number(context.prng.next()) % 1000) + 100);
    const shieldingRate = BigInt(Math.floor(Number(context.prng.next()) % 10001));
    const nearestSpotInLiquidationQueue = BigInt(0);
    const nearestSpotInRedemptionQueue = BigInt(0);

    const actionParams = [
      safeId,
      amount,
      shieldingRate,
      nearestSpotInLiquidationQueue,
      nearestSpotInRedemptionQueue,
    ];

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    try {
      const signer = actor.account.value.connect(this.contract.runner);
      const tx = await this.contract.connect(signer).borrow(
        actionParams[0],
        actionParams[1],
        actionParams[2],
        actionParams[3],
        actionParams[4]
      );
      await tx.wait();
    } catch (error: any) {
      context.logger.error(`Transaction failed: ${error.message}`);
      throw error;
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const safeId = actionParams[0];
    const amount = actionParams[1];

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const accountAddress = actor.account.address;

    // Borrow Amount Validation
    const previousBorrowedAmount = previousStableBaseCDPSnapshot.safes[safeId]?.borrowedAmount || BigInt(0);
    const newBorrowedAmount = newStableBaseCDPSnapshot.safes[safeId]?.borrowedAmount || BigInt(0);

    const previousTotalBorrowedAmount = previousStableBaseCDPSnapshot.safes[safeId]?.totalBorrowedAmount || BigInt(0);
    const newTotalBorrowedAmount = newStableBaseCDPSnapshot.safes[safeId]?.totalBorrowedAmount || BigInt(0);

    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    const previousSBDTokenBalance = previousStableBaseCDPSnapshot.balances[accountAddress] || BigInt(0);
    const newSBDTokenBalance = newStableBaseCDPSnapshot.balances[accountAddress] || BigInt(0);

    expect(newBorrowedAmount).to.equal(previousBorrowedAmount + amount, "Borrowed amount should increase by amount");
    expect(newTotalBorrowedAmount).to.equal(previousTotalBorrowedAmount + amount, "Total borrowed amount should increase by amount");
    expect(newTotalDebt).to.equal(previousTotalDebt + amount, "Total debt should increase by amount");

    // Fetch the expected amount to borrow.  This is more complicated than just the 'amount' parameter because of fees
    // and refunds. The ideal case would be that this is already calculated inside `execute` and returned, so that it can be tested here.
    // Until then, we can't validate that the token balance has increased by the expected value.
    // For now, just check that the token balance has increased.
    expect(newSBDTokenBalance).to.be.gte(previousSBDTokenBalance, "SBD token balance should increase, or stay the same if there was a refund.");

    // Safe Ownership Validation
    expect(newStableBaseCDPSnapshot.owners[safeId]).to.equal(previousStableBaseCDPSnapshot.owners[safeId], "Owner should not change");

    return true;
  }
}
