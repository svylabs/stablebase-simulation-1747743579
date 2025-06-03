import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { expect } from 'chai';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

export class BorrowAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('BorrowAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const safeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes);

    if (safeIds.length === 0) {
      throw new Error("No safes available to borrow from");
    }

    const safeIdStr = safeIds[context.prng.next() % safeIds.length];
    const safeId = parseInt(safeIdStr, 10);
    const owner = currentSnapshot.contractSnapshot.stableBaseCDP.owners[safeId];

    if (owner !== actor.account.address) {
      throw new Error("Safe is not owned by the actor");
    }

    // Fetch safe data to determine borrowable amount
    const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];
    if (!safe) {
        throw new Error("Safe not found in snapshot");
    }

    // Example: Assuming a simple collateralization ratio of 150%
    // and a fixed oracle price of 1 SBD per collateral unit
    const collateralAmount = safe.collateralAmount;

    // Assuming we can borrow upto 2/3rd of collateral
    const maxBorrowAmount = (collateralAmount * BigInt(2)) / BigInt(3);
    const minBorrowAmount = BigInt(1); // Ensure we borrow at least 1 unit

    // Generate a random amount within the allowed range
    const amount = minBorrowAmount + BigInt(context.prng.next() % Number(maxBorrowAmount - minBorrowAmount + BigInt(1)));


    const shieldingRate = BigInt(context.prng.next() % 10000); // Random rate between 0 and 9999 (BASIS_POINTS_DIVISOR)
    const nearestSpotInLiquidationQueue = BigInt(0); // Provide 0 if not known
    const nearestSpotInRedemptionQueue = BigInt(0); // Provide 0 if not known

    const actionParams = {
      safeId: BigInt(safeId),
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
        .connect(actor.account.value as HardhatEthersSigner)
        .borrow(
          safeId,
          amount,
          shieldingRate,
          nearestSpotInLiquidationQueue,
          nearestSpotInRedemptionQueue
        );
      await tx.wait();
    } catch (e) {
      console.log("execute error", e)
      throw e;
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const { safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue } = actionParams;

    const prevSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId] || { collateralAmount: BigInt(0), borrowedAmount: BigInt(0), weight: BigInt(0), totalBorrowedAmount: BigInt(0), feePaid: BigInt(0) };
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];
    const prevTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const sbdContractAddress = this.contract.target;
    const prevContractSBDTokenBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balances[sbdContractAddress] || BigInt(0);
    const newContractSBDTokenBalance = newSnapshot.contractSnapshot.stableBaseCDP.balances[sbdContractAddress] || BigInt(0);

    // Safe State Validation
    expect(newSafe.borrowedAmount).to.equal(prevSafe.borrowedAmount + amount, 'safes[safeId].borrowedAmount should increase by amount.');
    expect(newSafe.totalBorrowedAmount).to.equal(prevSafe.totalBorrowedAmount + amount, 'safes[safeId].totalBorrowedAmount should increase by amount.');

     // SBD Token Balance Validation. Since canRefund is not available we assume canRefund is 0 and shieldingFee is amount * shieldingRate / BASIS_POINTS_DIVISOR. BASIS_POINTS_DIVISOR is assumed to be 10000
    const shieldingFee = (amount * shieldingRate) / BigInt(10000);
    const expectedContractSBDTokenBalance = prevContractSBDTokenBalance + shieldingFee;

    // Validate the change in contract's SBD token balance
    expect(newContractSBDTokenBalance).to.equal(expectedContractSBDTokenBalance, "StableBaseCDP contract SBD token balance should increase by the Shielding fee.");

    // Protocol State Validation
    expect(newTotalDebt).to.equal(prevTotalDebt + amount, 'totalDebt should increase by amount borrowed.');

    // Additional validations based on state updates

    // Validate that if the safe didn't exist before, it exists now
    if (!previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId]) {
      expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId]).to.not.be.undefined;
    }

    //Validate cumulativeDebtPerUnitCollateral is updated.
        const prevLiquidationSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId] || { collateralPerCollateralSnapshot: BigInt(0), debtPerCollateralSnapshot: BigInt(0) };
    const newLiquidationSnapshot = newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId];
    if (prevLiquidationSnapshot.collateralPerCollateralSnapshot !== newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral) {
            expect(newLiquidationSnapshot.debtPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral, 'liquidationSnapshots[safeId].debtPerCollateralSnapshot should be updated to cumulativeDebtPerUnitCollateral');
            expect(newLiquidationSnapshot.collateralPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral, 'liquidationSnapshots[safeId].collateralPerCollateralSnapshot should be updated to cumulativeCollateralPerUnitCollateral');
    }

    return true;
  }
}
