import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
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
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPState = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeIds = Object.keys(stableBaseCDPState.safes).map(Number);

    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    // Filter safes with collateral
    const availableSafeIds = safeIds.filter(safeId => stableBaseCDPState.safes[safeId].collateralAmount > BigInt(0));

    if (availableSafeIds.length === 0) {
      return [false, {}, {}];
    }

    const safeId = availableSafeIds[context.prng.next() % availableSafeIds.length];
    const safe = stableBaseCDPState.safes[safeId];

    const mockPriceOracleState = currentSnapshot.contractSnapshot.mockPriceOracle;
    const price = mockPriceOracleState.price;
    // liquidationRatio, PRECISION, BASIS_POINTS_DIVISOR, MINIMUM_DEBT should ideally be fetched from the contract
    const liquidationRatio = BigInt(15000); // Example liquidation ratio
    const PRECISION = BigInt(10) ** BigInt(18); // Example precision
    const BASIS_POINTS_DIVISOR = BigInt(10000);
    const MINIMUM_DEBT = BigInt(100); // Example minimum debt

    const maxBorrowAmount = ((
      (safe.collateralAmount * price * BASIS_POINTS_DIVISOR)
    ) / liquidationRatio) / PRECISION - safe.borrowedAmount;

    if (maxBorrowAmount <= BigInt(0) || (safe.borrowedAmount + MINIMUM_DEBT > ((
      (safe.collateralAmount * price * BASIS_POINTS_DIVISOR)
    ) / liquidationRatio) / PRECISION)) {
      return [false, {}, {}];
    }

    const amount = BigInt(context.prng.next()) % (maxBorrowAmount - MINIMUM_DEBT + BigInt(1)) + MINIMUM_DEBT; // Ensure amount is within bounds and >= MINIMUM_DEBT
    const shieldingRate = BigInt(context.prng.next()) % BASIS_POINTS_DIVISOR;
    const nearestSpotInLiquidationQueue = BigInt(0); // Can be randomized if there's a valid range
    const nearestSpotInRedemptionQueue = BigInt(0); // Can be randomized if there's a valid range

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
  ): Promise<ExecutionReceipt> {
    const { safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue } = actionParams;
    return this.contract
      .connect(actor.account.value)
      .borrow(
        safeId,
        amount,
        shieldingRate,
        nearestSpotInLiquidationQueue,
        nearestSpotInRedemptionQueue
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
    const { safeId, amount, shieldingRate } = actionParams;
    const safeIdNumber = Number(safeId);

    // Validate events
    await expect(executionReceipt.events.length).to.be.greaterThan(0);
    const borrowedEvent = executionReceipt.events.find((event: any) => event.event === "Borrowed");
    expect(borrowedEvent).to.not.be.undefined;
    expect(borrowedEvent.args.safeId).to.eq(safeId);
    expect(borrowedEvent.args.amount).to.eq(amount);

    const feeDistributedEvent = executionReceipt.events.find((event: any) => event.event === "FeeDistributed");
    expect(feeDistributedEvent).to.not.be.undefined;

    const previousStableBaseCDPState = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPState = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousDFIDTokenState = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenState = newSnapshot.contractSnapshot.dfidToken;

    const previousSafe = previousStableBaseCDPState.safes[safeIdNumber] || {
      collateralAmount: BigInt(0),
      borrowedAmount: BigInt(0),
      weight: BigInt(0),
      totalBorrowedAmount: BigInt(0),
      feePaid: BigInt(0),
    };

    const newSafe = newStableBaseCDPState.safes[safeIdNumber];

    expect(newSafe).to.not.be.undefined;
    expect(newSafe.collateralAmount).to.be.gt(BigInt(0));

    // Safe State Validation
    expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amount);
    expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amount);

    // Calculate shielding fee
    const BASIS_POINTS_DIVISOR = BigInt(10000);
    const _shieldingFee = (amount * shieldingRate) / BASIS_POINTS_DIVISOR;
    expect(newSafe.feePaid).to.equal(previousSafe.feePaid + _shieldingFee);

    // Token Validation
    const borrowerAddress = actor.account.address;

    const previousBorrowerBalance = previousDFIDTokenState.balances[borrowerAddress] || BigInt(0);
    const newBorrowerBalance = newDFIDTokenState.balances[borrowerAddress] || BigInt(0);

    const canRefund = feeDistributedEvent.args.canRefund || BigInt(0);
    const amountToBorrow = amount - _shieldingFee + canRefund;

    expect(newBorrowerBalance).to.equal(previousBorrowerBalance + amountToBorrow);

    const previousTotalSupply = previousDFIDTokenState.totalSupply;
    const newTotalSupply = newDFIDTokenState.totalSupply;
    expect(newTotalSupply).to.equal(previousTotalSupply + amountToBorrow);

    // Protocol Debt Validation
    expect(newStableBaseCDPState.totalDebt).to.equal(previousStableBaseCDPState.totalDebt + amount);

    // Contract's SBD Balance Validation
    const stableBaseCDPAddress = (context.contracts.stableBaseCDP as ethers.Contract).target;
    const previousContractBalance = previousDFIDTokenState.balances[stableBaseCDPAddress] || BigInt(0);
    const newContractBalance = newDFIDTokenState.balances[stableBaseCDPAddress] || BigInt(0);

    // Assuming fees are distributed to the contract, so contract balance should increase
    const feePaid = feeDistributedEvent.args.feePaid || BigInt(0);
    expect(newContractBalance).to.equal(previousContractBalance + feePaid);

    // DFIREStaking reward validation
    const previousDFIREStakingState = previousSnapshot.contractSnapshot.dfireStaking;
    const newDFIREStakingState = newSnapshot.contractSnapshot.dfireStaking;
    const dfireStakingAddress = (context.contracts.dfireStaking as ethers.Contract).target;    
    const sbrStakersFee = feeDistributedEvent.args.sbrStakersFee || BigInt(0);

     if (sbrStakersFee > BigInt(0)) {
          expect(newDFIREStakingState.totalRewardPerToken).to.be.gte(previousDFIREStakingState.totalRewardPerToken);
     }

    // StabilityPool reward validation
    const previousStabilityPoolState = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolState = newSnapshot.contractSnapshot.stabilityPool;
    const stabilityPoolAddress = (context.contracts.stabilityPool as ethers.Contract).target;
    const stabilityPoolFee = feeDistributedEvent.args.stabilityPoolFee || BigInt(0);

    if (stabilityPoolFee > BigInt(0)) {
         expect(newStabilityPoolState.totalRewardPerToken).to.be.gte(previousStabilityPoolState.totalRewardPerToken);
    }

    return true;
  }
}
