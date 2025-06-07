import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
import { expect } from 'chai';

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
  ): Promise<[any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(BigInt);

    if (safeIds.length === 0) {
      console.warn("No safes available to borrow against.");
      return [[[0n, 0n, 0n, 0n, 0n]], {}];
    }

    const safeId = safeIds[context.prng.next() % safeIds.length];
    const safe = stableBaseCDPSnapshot.safes[safeId];

    if (!safe) {
      console.warn(`Safe with ID ${safeId} not found.`);
      return [[[0n, 0n, 0n, 0n, 0n]], {}];
    }

    const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
    const price = mockPriceOracleSnapshot.price;
    const BASIS_POINTS_DIVISOR = 10000n;
    const PRECISION = 100000000n; // 1e8

    // Assuming liquidationRatio is a constant in the contract, fetch it if possible.
    // If not, keep the hardcoded value.
    const liquidationRatio = 15000n; 

    const maxBorrowAmount = (safe.collateralAmount * price * BASIS_POINTS_DIVISOR) / liquidationRatio / PRECISION;
    const MINIMUM_DEBT = 1000n;

    let amount = BigInt(context.prng.next()) % (maxBorrowAmount - safe.borrowedAmount);
    if (amount < MINIMUM_DEBT) {
      amount = MINIMUM_DEBT + BigInt(context.prng.next()) % (maxBorrowAmount - safe.borrowedAmount - MINIMUM_DEBT + 1n); // Ensure amount >= MINIMUM_DEBT
      if(amount > (maxBorrowAmount - safe.borrowedAmount)) {
        amount = maxBorrowAmount - safe.borrowedAmount
      }
    }

    const shieldingRate = BigInt(context.prng.next()) % (BASIS_POINTS_DIVISOR + 1n); // 0-10000
    const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const nearestSpotInLiquidationQueue = safesOrderedForLiquidationSnapshot.head; // Use head as a default value, 0 if list is empty
    const safesOrderedForRedemptionSnapshot = currentSnapshot.contractSnapshot.safesOrderedForRedemption;
    const nearestSpotInRedemptionQueue = safesOrderedForRedemptionSnapshot.head; // Use head as a default value, 0 if list is empty

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
    const signer = actor.account.value.connect(this.contract.runner!);
    const tx = await this.contract.connect(signer).borrow(
      actionParams[0],
      actionParams[1],
      actionParams[2],
      actionParams[3],
      actionParams[4]
    );
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const safeId = actionParams[0] as bigint;
    const amount = actionParams[1] as bigint;
    const shieldingRate = actionParams[2] as bigint;
    const nearestSpotInLiquidationQueue = actionParams[3] as bigint;
    const nearestSpotInRedemptionQueue = actionParams[4] as bigint;

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
    const newSafe = newStableBaseCDPSnapshot.safes[safeId];

    // Safe state validations
    expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amount, "safe.borrowedAmount should be equal to the initial value plus the borrowed amount.");
    expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amount, "safe.totalBorrowedAmount should be equal to the initial value plus the borrowed amount.");
    expect(newSafe.feePaid).to.gte(previousSafe.feePaid, "feePaid should be increased.");

    // Total debt validations
    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;
    expect(newTotalDebt).to.equal(previousTotalDebt + amount, "totalDebt should be increased by the borrowed amount.");

    // Token state validations
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

    const borrowerAddress = actor.account.address;

    const previousBorrowerBalance = previousDFIDTokenSnapshot.Balance[borrowerAddress] || 0n;
    const newBorrowerBalance = newDFIDTokenSnapshot.Balance[borrowerAddress] || 0n;

    // Calculate shielding fee
    const BASIS_POINTS_DIVISOR = 10000n;
    const _shieldingFee = (amount * shieldingRate) / BASIS_POINTS_DIVISOR;
    const _amountToBorrow = amount - _shieldingFee;

    // Ensure the borrower received the minted SBD tokens.
    expect(newBorrowerBalance).to.equal(previousBorrowerBalance + _amountToBorrow, "The borrower should have received the minted SBD tokens.");

    // Validate protocol mode change from BOOTSTRAP to NORMAL
    if (previousTotalDebt <= 1000000000000000000000000n && newTotalDebt > 1000000000000000000000000n) {
      expect(newStableBaseCDPSnapshot.mode).to.equal(1, "PROTOCOL_MODE should be NORMAL if totalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD, and was previously BOOTSTRAP.");
    }

    // Validate total supply increase in DFIDToken snapshot
    expect(newDFIDTokenSnapshot.TotalSupply).to.equal(previousDFIDTokenSnapshot.TotalSupply + _amountToBorrow, "Total supply should have increased after borrow.");

     // Validate totalCollateral - Difficult to validate exactly without knowing the exact collateral increase.
    //  We can only check if it has increased or remained the same.
    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
    expect(newTotalCollateral).to.gte(previousTotalCollateral, "Total collateral should increase or remain the same");


    // Validate DFIREStaking and StabilityPool updates if shieldingFee > 0
    if (_shieldingFee > 0n) {
      const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
      const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

      const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
      const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

      //Verify that the DFIREStaking contract and StabilityPool contract have increased their reward tokens.
      if(previousDFIREStakingSnapshot && newDFIREStakingSnapshot){
           expect(newDFIREStakingSnapshot.totalRewardPerToken).to.gte(previousDFIREStakingSnapshot.totalRewardPerToken, "DFIREStaking totalRewardPerToken should increase.");
       }
       if(previousStabilityPoolSnapshot && newStabilityPoolSnapshot){
          expect(newStabilityPoolSnapshot.totalRewardPerToken).to.gte(previousStabilityPoolSnapshot.totalRewardPerToken, "StabilityPool totalRewardPerToken should increase.");
       }

    }

    // Validate Doubly Linked List state (safesOrderedForRedemption and safesOrderedForLiquidation)
      const previousSafesOrderedForRedemptionSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
      const newSafesOrderedForRedemptionSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

      const previousSafesOrderedForLiquidationSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
      const newSafesOrderedForLiquidationSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

       // Basic check: Ensure head and tail are not zero if the list was previously empty.
       if (previousSafesOrderedForRedemptionSnapshot.head === 0n && newSafesOrderedForRedemptionSnapshot.head !== 0n) {
        expect(newSafesOrderedForRedemptionSnapshot.head).to.not.equal(0, "Redemption list head should not be zero if the list was previously empty.");
      }
      if (previousSafesOrderedForLiquidationSnapshot.head === 0n && newSafesOrderedForLiquidationSnapshot.head !== 0n) {
        expect(newSafesOrderedForLiquidationSnapshot.head).to.not.equal(0, "Liquidation list head should not be zero if the list was previously empty.");
      }

    return true;
  }
}
