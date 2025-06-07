import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

export class RepayAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('RepayAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const safeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes);
    if (safeIds.length === 0) {
      throw new Error("No safes available for repayment");
    }

    const safeId = safeIds[context.prng.next() % safeIds.length];
    const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];

    if (!safe || safe.borrowedAmount === BigInt(0)) {
      throw new Error(`Safe with ID ${safeId} has no debt to repay.`);
    }

    const maxRepayAmount = safe.borrowedAmount;
    const amount = BigInt(Math.floor(context.prng.next() % Number(maxRepayAmount) + 1)); // Ensure amount > 0

    let nearestSpotInLiquidationQueue = BigInt(0);
        const liquidationQueueHead = currentSnapshot.contractSnapshot.safesOrderedForLiquidation.head;
        if (liquidationQueueHead !== BigInt(0)) {
            let current = liquidationQueueHead;
            let nearestSpotFound = false;
            while (current !== BigInt(0) && !nearestSpotFound) {
                if (current !== BigInt(safeId)) { // Avoid using the same safeId as nearestSpot
                    nearestSpotInLiquidationQueue = current;
                    nearestSpotFound = true;
                }
                current = currentSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[current.toString()].next;
            }
            if (!nearestSpotFound) {
                nearestSpotInLiquidationQueue = liquidationQueueHead; // Revert to head if no other suitable spot is found
            }
        }

    const actionParams = [
      BigInt(safeId),
      amount,
      nearestSpotInLiquidationQueue,
    ];

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [safeId, amount, nearestSpotInLiquidationQueue] = actionParams;
    const tx = await this.contract.connect(actor.account.value).repay(
      safeId,
      amount,
      nearestSpotInLiquidationQueue
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
    const [safeId, amount, nearestSpotInLiquidationQueue] = actionParams;

    const prevSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];
    const initialTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const finalTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const initialTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    const finalTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;

    const dfidTokenAddress = (context.contracts.dfidToken as any).target;

    const previousSBDTokenBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newSBDTokenBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const previousSBDContractTokenBalance = previousSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);
    const newSBDContractTokenBalance = newSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);

    const initialLiquidationSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId] || [BigInt(0), BigInt(0)];
    const finalLiquidationSnapshot = newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId] || [BigInt(0), BigInt(0)];


    // Safe State Validation
    expect(newSafe.borrowedAmount, 'borrowedAmount should be decreased by amount').to.equal(prevSafe.borrowedAmount - amount);

    // Total Debt Validation
    expect(finalTotalDebt, 'totalDebt should be decreased by repayment amount').to.equal(initialTotalDebt - amount);

    // SBD Token Validation
    expect(newSBDTokenBalance, "SBD Token balance should decrease for actor").to.equal(previousSBDTokenBalance - amount);

    // Check if totalCollateral got updated
    const cumulativeCollateralPerUnitCollateralPrevious = previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral;
    const cumulativeCollateralPerUnitCollateralNew = newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral;

    if (initialLiquidationSnapshot[1] != cumulativeCollateralPerUnitCollateralPrevious) {
          // totalCollateral should be updated
          expect(finalTotalCollateral).to.not.equal(initialTotalCollateral);
    }

    return true;
  }
}
