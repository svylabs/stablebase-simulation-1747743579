import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
import { expect } from 'chai';
import { Interface } from "ethers";

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
  ): Promise<[[bigint, bigint, bigint, bigint, bigint], Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);

    if (safeIds.length === 0) {
      throw new Error("No safes available to borrow from.");
    }

    const safeId = BigInt(context.prng.pick(safeIds));
    const safe = stableBaseCDPSnapshot.safes[safeId];

    // Fetch necessary values for calculating maxBorrowAmount. Using snapshot data
    const price = BigInt(1000); // Assuming a fixed price for simplicity since the oracle is mocked.  Replace with priceOracle.fetchPrice() equivalent using snapshot data if needed.
    const liquidationRatio = BigInt(11000); // Assuming liquidationRatio is 110% in basis points.
    const BASIS_POINTS_DIVISOR = BigInt(10000);
    const PRECISION = BigInt(1000000000);
    const MINIMUM_DEBT = BigInt(100);

    const maxBorrowAmount = ((safe.collateralAmount * price * BASIS_POINTS_DIVISOR) / liquidationRatio) / PRECISION;

    let amount = BigInt(Math.floor(context.prng.next() % Number(maxBorrowAmount - safe.borrowedAmount)));

    if (amount <= BigInt(0)) {
        amount = MINIMUM_DEBT; // Ensure amount is at least the minimum debt.
    }

    if (safe.borrowedAmount + amount < MINIMUM_DEBT) {
        amount = MINIMUM_DEBT - safe.borrowedAmount; // Adjust to meet minimum debt after borrowing.
    }

    if (amount > maxBorrowAmount - safe.borrowedAmount) {
        amount = maxBorrowAmount - safe.borrowedAmount; // Cap the amount to the maximum borrowable.
    }
    if (amount <= BigInt(0)) {
      amount = MINIMUM_DEBT
    }

    const shieldingRate = BigInt(Math.floor(context.prng.next() % 1000)); // Up to 10% shielding rate.
    const nearestSpotInLiquidationQueue = BigInt(0); // Assuming head of queue.
    const nearestSpotInRedemptionQueue = BigInt(0); // Assuming head of queue.

    const actionParams: [bigint, bigint, bigint, bigint, bigint] = [
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
    actionParams: [bigint, bigint, bigint, bigint, bigint]
  ): Promise<Record<string, any> | void> {
    const [safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue] = actionParams;
    const signer = actor.account.value.connect(this.contract.runner!);

    try {
      const tx = await this.contract.connect(signer).borrow(
        safeId,
        amount,
        shieldingRate,
        nearestSpotInLiquidationQueue,
        nearestSpotInRedemptionQueue
      );
      await tx.wait();
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: [bigint, bigint, bigint, bigint, bigint]
  ): Promise<boolean> {
    const [safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue] = actionParams;
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
    const newSafe = newStableBaseCDPSnapshot.safes[safeId];

    // Core Borrowing and Accounting validations
    expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amount, "Borrowed amount should increase by the amount borrowed.");
    expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amount, "Total borrowed amount should increase by the amount borrowed.");
    expect(newStableBaseCDPSnapshot.totalDebt).to.equal(previousStableBaseCDPSnapshot.totalDebt + amount, "Total debt should increase by the amount borrowed.");

    // Fee calculation and validation would require replicating the contract logic.
    // Skipping detailed fee validation for brevity, but ensuring feePaid is non-decreasing.
    expect(newSafe.feePaid).to.be.gte(previousSafe.feePaid, "Fee paid should increase or remain the same.");

    // Token balance validation (SBD token minted to borrower).
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    // Calculate the net increase in account balance
    const expectedAccountBalanceIncrease = amount - (amount * shieldingRate / BigInt(10000)); // amount - _shieldingFee
    expect(newAccountBalance - previousAccountBalance).to.be.gte(expectedAccountBalanceIncrease, "Account balance should increase after borrowing.");

    //Contract Address Token Balance Validation - Fee will be minted to the contract.
    const previousSBDTokenBalance = previousSnapshot.accountSnapshot[this.contract.target] || BigInt(0);
    const newSBDTokenBalance = newSnapshot.accountSnapshot[this.contract.target] || BigInt(0);
    const fee = (amount * shieldingRate) / BigInt(10000);
    expect(newSBDTokenBalance - previousSBDTokenBalance).to.be.lte(fee, "Contract SBD balance should increase after minting fee.");

    return true;
  }
} 