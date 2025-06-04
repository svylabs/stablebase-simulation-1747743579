import { ethers } from "ethers";
import { expect } from 'chai';
import { Action, Actor, RunContext, Snapshot } from "@svylabs/ilumia";

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
    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);
    const ownerSafes = safeIds.filter((safeId) => stableBaseCDPSnapshot.owners[safeId] === actor.account.address);

    if (ownerSafes.length === 0) {
      throw new Error("No Safe owned by the actor");
    }

    const safeId = ownerSafes[Math.floor(context.prng.next() % ownerSafes.length)];

    // Validate ownership before proceeding
    if (stableBaseCDPSnapshot.owners[safeId] !== actor.account.address) {
      throw new Error("Actor does not own the selected Safe.");
    }

    // Example bounds based on snapshot (replace with actual bounds)
    const maxBorrowAmount = 1000n; // Example max, fetch from snapshot if available
    const maxShieldingRate = 10000n; // Example max (basis points), fetch from snapshot if available

    const amount = BigInt(Math.floor(context.prng.next() % Number(maxBorrowAmount)) + 1); // Non-zero amount
    const shieldingRate = BigInt(Math.floor(context.prng.next() % Number(maxShieldingRate))); // Up to 100%
    const nearestSpotInLiquidationQueue = BigInt(Math.floor(context.prng.next() % 100)); // Example
    const nearestSpotInRedemptionQueue = BigInt(Math.floor(context.prng.next() % 100)); // Example

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
    actionParams: any
  ): Promise<boolean> {
    const safeId = actionParams.safeId;
    const amount = actionParams.amount;
    const shieldingRate = actionParams.shieldingRate;

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    const previousSafes = previousStableBaseCDPSnapshot.safes;
    const newSafes = newStableBaseCDPSnapshot.safes;

    const previousSafe = previousSafes[safeId];
    const newSafe = newSafes[safeId];

    const BASIS_POINTS_DIVISOR = 10000n;
    const _shieldingFee = (amount * shieldingRate) / BASIS_POINTS_DIVISOR;

    // Assuming canRefund is zero for simplicity, as full logic requires contract interaction
    const canRefund = 0n;
    const _amountToBorrow = amount - _shieldingFee + canRefund;

    // Token Balance
    const borrowerAddress = actor.account.address;
    const previousBorrowerBalance = previousSnapshot.accountSnapshot[borrowerAddress] || 0n;
    const newBorrowerBalance = newSnapshot.accountSnapshot[borrowerAddress] || 0n;
    expect(newBorrowerBalance - previousBorrowerBalance).to.equal(_amountToBorrow, "Borrower SBD balance should increase by the borrowed amount minus the shielding fee.");

    // Debt Tracking
    expect(newStableBaseCDPSnapshot.totalDebt - previousStableBaseCDPSnapshot.totalDebt).to.equal(amount, "Total debt in the StableBaseCDP contract should increase by the borrowed amount.");

    // Safe State
    expect(newSafe.borrowedAmount - previousSafe.borrowedAmount).to.equal(amount, "Safe's borrowedAmount should increase by the borrowed amount.");
    expect(newSafe.totalBorrowedAmount - previousSafe.totalBorrowedAmount).to.equal(amount, "Safe's totalBorrowedAmount should increase by the borrowed amount.");
    expect(newSafe.feePaid - previousSafe.feePaid).to.equal(_shieldingFee, "Safe's feePaid should increase by the shielding fee amount.");

    // Cumulative Debt and Collateral
    if (previousStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral !== newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral) {
      // Validate _safe.borrowedAmount, _safe.totalBorrowedAmount, _safe.collateralAmount, totalDebt
      const liquidationSnapshot = previousStableBaseCDPSnapshot.liquidationSnapshots[safeId];
      if (liquidationSnapshot.collateralPerCollateralSnapshot !== previousStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral) {
        const debtIncrease = (previousSafe.collateralAmount * (newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral - liquidationSnapshot.debtPerCollateralSnapshot)) / 1000000000000000000n; // PRECISION
        const collateralIncrease = (previousSafe.collateralAmount * (newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral - liquidationSnapshot.collateralPerCollateralSnapshot)) / 1000000000000000000n; // PRECISION

        //Safe
        expect(newSafe.borrowedAmount - previousSafe.borrowedAmount).to.equal(debtIncrease + amount, "Safe's borrowedAmount should increase by debtIncrease.");
        expect(newSafe.totalBorrowedAmount - previousSafe.totalBorrowedAmount).to.equal(debtIncrease + amount, "Safe's totalBorrowedAmount should increase by debtIncrease.");
        expect(newSafe.collateralAmount - previousSafe.collateralAmount).to.equal(collateralIncrease, "Safe's collateralAmount should increase by collateralIncrease.");

        //liquidationSnapshot
        expect(liquidationSnapshot.debtPerCollateralSnapshot).to.equal(previousStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral, "liquidationSnapshot.debtPerCollateralSnapshot should equal cumulativeDebtPerUnitCollateral");
        expect(liquidationSnapshot.collateralPerCollateralSnapshot).to.equal(previousStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral, "liquidationSnapshot.collateralPerCollateralSnapshot should equal cumulativeCollateralPerUnitCollateral");

        //Total collateral and debt
        expect(newStableBaseCDPSnapshot.totalCollateral - previousStableBaseCDPSnapshot.totalCollateral).to.equal(collateralIncrease, "totalCollateral should increase by collateralIncrease");
        expect(newStableBaseCDPSnapshot.totalDebt - previousStableBaseCDPSnapshot.totalDebt).to.equal(debtIncrease + amount, "totalDebt should increase by debtIncrease");
      }
    }

    // Protocol Mode Transition (Example validation)
    if (previousStableBaseCDPSnapshot.mode === 0 && newStableBaseCDPSnapshot.mode === 1) {
      // Assuming 0 is BOOTSTRAP and 1 is NORMAL.  Replace with actual enum values.
      expect(previousStableBaseCDPSnapshot.totalDebt).to.be.lessThan(10000n); // Example threshold
      expect(newStableBaseCDPSnapshot.totalDebt).to.be.greaterThanOrEqual(10000n); // Example threshold
    }

    // SBD Token Supply (Assuming you can access the sbdToken contract address)
    const sbdTokenAddress = "0x..."; // Replace with actual SBD token address
    const previousSBDSupply = previousSnapshot.accountSnapshot[sbdTokenAddress] || 0n;
    const newSBDSupply = newSnapshot.accountSnapshot[sbdTokenAddress] || 0n;
    expect(newSBDSupply - previousSBDSupply).to.equal(_amountToBorrow, "SBD token supply should increase by the borrowed amount.");

    //StabilityPool fee distribution
    const sbrStakersFee = (_shieldingFee * 1000n) / 10000n;
    const stabilityPoolFee = _shieldingFee - sbrStakersFee;

    // Assuming you have access to dfireTokenStaking and stabilityPool contract addresses from a config or snapshot
    const dfireTokenStakingAddress = "0x..."; // Replace with actual dfireTokenStaking contract address
    const stabilityPoolAddress = "0x..."; // Replace with actual stabilityPool contract address

    const previousDfireTokenStakingBalance = previousSnapshot.accountSnapshot[dfireTokenStakingAddress] || 0n;
    const newDfireTokenStakingBalance = newSnapshot.accountSnapshot[dfireTokenStakingAddress] || 0n;
    expect(newDfireTokenStakingBalance - previousDfireTokenStakingBalance).to.equal(sbrStakersFee, "dfireTokenStaking balance should increase by sbrStakersFee");

    const previousStabilityPoolBalance = previousSnapshot.accountSnapshot[stabilityPoolAddress] || 0n;
    const newStabilityPoolBalance = newSnapshot.accountSnapshot[stabilityPoolAddress] || 0n;
    expect(newStabilityPoolBalance - previousStabilityPoolBalance).to.equal(stabilityPoolFee, "stabilityPool balance should increase by stabilityPoolFee");


    // TODO: Validate safe.weight, and queue updates (liquidation and redemption).

    return true;
  }
}
