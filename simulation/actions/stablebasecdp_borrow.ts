import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
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
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    // Find a safeId owned by the actor
    let safeId: bigint | undefined;
    try {
      for (const id in stableBaseCDPSnapshot.owners) {
        if (stableBaseCDPSnapshot.owners[id] === actor.account.address) {
          safeId = BigInt(id);
          break;
        }
      }

      if (!safeId) {
        throw new Error(`No safeId found owned by ${actor.account.address}`);
      }
    } catch (error) {
        console.error("Error finding safeId:", error);
        throw error;
    }

    // Generate random values for parameters
    const amount = BigInt(Math.floor(context.prng.next() % 10000) + 1); // Amount > 0
    const shieldingRate = BigInt(Math.floor(context.prng.next() % 10001)); // 0 to 10000 (0% to 100%)
    const nearestSpotInLiquidationQueue = BigInt(0); // Can be 0
    const nearestSpotInRedemptionQueue = BigInt(0); // Can be 0

    const actionParams = {
      safeId: safeId,
      amount: amount,
      shieldingRate: shieldingRate,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
      nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
    };

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue } = actionParams;

    try {
      const tx = await this.contract
        .connect(actor.account.value as unknown as ethers.Signer)
        .borrow(
          safeId,
          amount,
          shieldingRate,
          nearestSpotInLiquidationQueue,
          nearestSpotInRedemptionQueue
        );
      await tx.wait();
    } catch (error) {
      console.error("Execution error:", error);
      throw error; // Re-throw the error to fail the test
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const { safeId, amount } = actionParams;

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe = previousStableBaseCDPSnapshot.safes[safeId.toString()];
    const newSafe = newStableBaseCDPSnapshot.safes[safeId.toString()];

    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    const sbdTokenAddress = await this.contract.sbdToken();

    const previousSBDTokenBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newSBDTokenBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    // Borrow Amount Validation
    expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amount, "safes[safeId].borrowedAmount should be equal to the previous borrowed amount + amount after execution.");
    expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amount, "safes[safeId].totalBorrowedAmount should be equal to the previous total borrowed amount + amount after execution.");
    expect(newTotalDebt).to.equal(previousTotalDebt + amount, "totalDebt should be equal to the previous totalDebt + amount after execution.");
    expect(newSBDTokenBalance).to.be.gte(previousSBDTokenBalance, "The borrower's SBD token balance should increase or remain the same.");

    // Safe Ownership Validation
    expect(newStableBaseCDPSnapshot.owners[safeId.toString()]).to.equal(actor.account.address, "ownerOf(safeId) should still return msg.sender after the borrow operation.");

    return true;
  }
}
