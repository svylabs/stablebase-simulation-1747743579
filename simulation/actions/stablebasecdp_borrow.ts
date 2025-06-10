import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class BorrowAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("BorrowAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
    const dfidToken = currentSnapshot.contractSnapshot.dfidToken;
    const mockPriceOracle = currentSnapshot.contractSnapshot.mockPriceOracle;

    if (!stableBaseCDP || !dfidToken || !mockPriceOracle) {
      console.warn("Required contract snapshot not found.");
      return [false, {}, {}];
    }

    const safeIds = Object.keys(stableBaseCDP.safes).map(Number);
    if (safeIds.length === 0) {
      console.warn("No safes available for borrowing.");
      return [false, {}, {}];
    }

    let safeId: number;
    let safe;
    let attempts = 0;
    const maxAttempts = 10;

    do {
      safeId = context.prng.pick(safeIds);
      safe = stableBaseCDP.safes[safeId];
      attempts++;

      if (!safe || safe.collateralAmount === BigInt(0)) {
        console.warn(`Safe ${safeId} does not exist or has no collateral, trying another safe. Attempt: ${attempts}`);
      }
    } while ((!safe || safe.collateralAmount === BigInt(0)) && attempts < maxAttempts);

    if (!safe || safe.collateralAmount === BigInt(0)) {
      console.warn("No valid safes found after multiple attempts.");
      return [false, {}, {}];
    }

    const price = mockPriceOracle.price;
    const liquidationRatio = BigInt(15000); // Example liquidation ratio (150%)
    const PRECISION = BigInt(10) ** BigInt(18); // Example precision
    const BASIS_POINTS_DIVISOR = BigInt(10000);
    const MINIMUM_DEBT = BigInt(100); // Example minimum debt

    const maxBorrowAmount = (
      (safe.collateralAmount * price * BASIS_POINTS_DIVISOR) / liquidationRatio
    ) / PRECISION - safe.borrowedAmount;

    if (maxBorrowAmount <= BigInt(0)) {
      console.warn("Maximum borrow amount is zero or less.");
      return [false, {}, {}];
    }

    const amount = BigInt(context.prng.next()) % maxBorrowAmount + MINIMUM_DEBT;
    const shieldingRate = BigInt(context.prng.next()) % BigInt(10000); // Up to 100%
    const nearestSpotInLiquidationQueue = BigInt(0);
    const nearestSpotInRedemptionQueue = BigInt(0);

    const actionParams = {
      safeId: BigInt(safeId),
      amount: amount,
      shieldingRate: shieldingRate,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
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
      .borrow(
        actionParams.safeId,
        actionParams.amount,
        actionParams.shieldingRate,
        actionParams.nearestSpotInLiquidationQueue,
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
    const safeId = actionParams.safeId;
    const amount = actionParams.amount;
    const shieldingRate = actionParams.shieldingRate;

    const prevStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;
    const prevDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;

    if (!prevStableBaseCDP || !newStableBaseCDP || !prevDFIDToken || !newDFIDToken) {
      console.warn("Required contract snapshot not found.");
      return false;
    }

    const prevSafe = prevStableBaseCDP.safes[Number(safeId.toString())];
    const newSafe = newStableBaseCDP.safes[Number(safeId.toString())];

    if (!newSafe) {
      expect(newStableBaseCDP.safes[Number(safeId.toString())]).to.not.be.undefined, 'Safe should still exist after borrow';
    }

    if (!prevSafe || !newSafe) {
      console.warn("Safe not found in previous or new snapshot.");
      return false;
    }

    // Calculate Shielding Fee
    const shieldingFee = (amount * shieldingRate) / BigInt(10000);

    // Safe State Validation
    expect(newSafe.borrowedAmount).to.equal(prevSafe.borrowedAmount + amount, "Incorrect borrowedAmount");
    expect(newSafe.totalBorrowedAmount).to.equal(prevSafe.totalBorrowedAmount + amount, "Incorrect totalBorrowedAmount");
    expect(newSafe.feePaid).to.gte(prevSafe.feePaid, "Fee paid should increase or remain the same");

    // Protocol Debt Validation
    expect(newStableBaseCDP.totalDebt).to.equal(prevStableBaseCDP.totalDebt + amount, "Incorrect totalDebt");

    // Token Validation - Borrower's SBD balance
    const borrowerAddress = actor.account.address; // Assuming actor's account is the borrower
    const prevBorrowerBalance = prevDFIDToken.balances[borrowerAddress] || BigInt(0);
    const newBorrowerBalance = newDFIDToken.balances[borrowerAddress] || BigInt(0);
    const expectedBorrowerBalance = prevBorrowerBalance + (amount - shieldingFee);

    expect(newBorrowerBalance).to.equal(expectedBorrowerBalance, "Incorrect borrower balance after borrowing");

    // Token Validation - Total Supply
    const prevTotalSupply = prevDFIDToken.totalSupply;
    const newTotalSupply = newDFIDToken.totalSupply;
    const expectedTotalSupply = prevTotalSupply + (amount - shieldingFee);

    expect(newTotalSupply).to.equal(expectedTotalSupply, "Incorrect total supply after borrowing");

    // Fee distribution validation - Assuming fees are distributed to the contract
    const prevContractBalance = prevDFIDToken.balances[this.contract.target] || BigInt(0);
    const newContractBalance = newDFIDToken.balances[this.contract.target] || BigInt(0);
    expect(newContractBalance).to.gte(prevContractBalance, "Contract balance should increase due to fee distribution");

    // Event Validation - Assuming Borrowed event is emitted
    const borrowedEvent = executionReceipt.events.find((event) => event.event === "Borrowed");
    expect(borrowedEvent).to.not.be.undefined, "Borrowed event should be emitted";

    if (borrowedEvent) {
      expect(borrowedEvent.args.safeId).to.equal(safeId, "Borrowed event: Incorrect safeId");
      expect(borrowedEvent.args.amount).to.equal(amount, "Borrowed event: Incorrect amount");
    }

    return true;
  }
}
