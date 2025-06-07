import { ethers } from 'ethers';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { expect } from 'chai';

class AddCollateralAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("AddCollateralAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safes = stableBaseCDPSnapshot.safes;

    let safeId: bigint | undefined;
    const safeIds = Object.keys(safes).filter(id => safes[id].collateralAmount > BigInt(0));

    if (safeIds.length === 0) {
      throw new Error("No existing safe with collateral found.");
    }

    safeId = BigInt(safeIds[Math.floor(context.prng.next() % safeIds.length)]);

    // Calculate a random amount, capped by the actor's ETH balance
    const actorBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const maxAmount = actorBalance > BigInt(1000) ? BigInt(1000) : actorBalance;
    const amount = maxAmount > BigInt(0) ? BigInt(Math.floor(context.prng.next() % Number(maxAmount))) + BigInt(1) : BigInt(0);

    const nearestSpotInLiquidationQueue = BigInt(0); // Assuming zero if the list is empty. Can get head from snapshot if needed.

    const actionParams = {
      safeId: safeId,
      amount: amount,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
      value: amount,
    };

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { safeId, amount, nearestSpotInLiquidationQueue, value } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .addCollateral(safeId, amount, nearestSpotInLiquidationQueue, {
        value: value,
      });

    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const { safeId, amount } = actionParams;
    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe = stableBaseCDPPrevious.safes[safeId.toString()];
    const newSafe = stableBaseCDPNew.safes[safeId.toString()];

    const previousTotalCollateral = stableBaseCDPPrevious.totalCollateral;
    const newTotalCollateral = stableBaseCDPNew.totalCollateral;
    const previousTotalDebt = stableBaseCDPPrevious.totalDebt;
    const newTotalDebt = stableBaseCDPNew.totalDebt;

    // Collateral & Debt Updates
    if (previousSafe && newSafe) {
      // Check collateralAmount increased
      expect(newSafe.collateralAmount).to.be.gte(previousSafe.collateralAmount);

      // Check totalCollateral increased
      expect(newTotalCollateral).to.be.gte(previousTotalCollateral);

      if (
        stableBaseCDPPrevious.cumulativeCollateralPerUnitCollateral !=
        stableBaseCDPNew.cumulativeCollateralPerUnitCollateral
      ) {
        //If cumulativeCollateralPerUnitCollateral changes borrowedAmount, collateralAmount, totalCollateral and totalDebt are updated.

        //Check if borrowed amount is updated
        expect(newSafe.borrowedAmount).to.be.gte(previousSafe.borrowedAmount);

        //Check if collateral amount is updated
        expect(newSafe.collateralAmount).to.be.gte(previousSafe.collateralAmount);

        //Check if totalCollateral is updated
        expect(newTotalCollateral).to.be.gte(previousTotalCollateral);

        // Check if totalDebt is updated
        expect(newTotalDebt).to.be.gte(previousTotalDebt);
      }

      //Check liquidation snapshot is updated
      const previousLiquidationSnapshot = stableBaseCDPPrevious.liquidationSnapshots && stableBaseCDPPrevious.liquidationSnapshots[safeId.toString()] ? stableBaseCDPPrevious.liquidationSnapshots[safeId.toString()] : undefined;
      const newLiquidationSnapshot = stableBaseCDPNew.liquidationSnapshots && stableBaseCDPNew.liquidationSnapshots[safeId.toString()] ? stableBaseCDPNew.liquidationSnapshots[safeId.toString()] : undefined;

      if (newLiquidationSnapshot && previousLiquidationSnapshot) {
          expect(newLiquidationSnapshot.collateralPerCollateralSnapshot).to.be.gte(previousLiquidationSnapshot.collateralPerCollateralSnapshot);
          expect(newLiquidationSnapshot.debtPerCollateralSnapshot).to.be.gte(previousLiquidationSnapshot.debtPerCollateralSnapshot);
      }

        // Check protocol mode if debt exceeds threshold
        if (newTotalDebt > 1000 && stableBaseCDPPrevious.mode == 0 && stableBaseCDPNew.mode ==1) {
          expect(stableBaseCDPNew.mode).to.equal(1);
        }
    } else {
      throw new Error("Safe not found in snapshot.");
    }

    //Account Balance validations
    expect(newSnapshot.accountSnapshot[actor.account.address]).to.be.lte(previousSnapshot.accountSnapshot[actor.account.address] - amount);

    return true;
  }
}

export default AddCollateralAction;
