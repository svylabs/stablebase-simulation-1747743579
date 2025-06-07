import { ethers } from 'ethers';
import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { expect } from 'chai';

export class RepayAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {\n    super('RepayAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const stableBaseCDPContract = context.contracts['stableBaseCDP'];
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;

    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);
    if (safeIds.length === 0) {
      throw new Error('No safes available to repay.');
    }

    const safeId = safeIds[context.prng.next() % safeIds.length];
    const safe = stableBaseCDPSnapshot.safes[BigInt(safeId)];

    if (!safe || safe.borrowedAmount === BigInt(0)) {
      throw new Error('Safe does not exist or has no debt to repay.');
    }

    const userAddress = actor.account.address;
    const sbdBalance = dfidTokenSnapshot.Balance[userAddress] || BigInt(0);
    const borrowedAmount = safe.borrowedAmount;
    const minimumDebt = BigInt(500); // Assuming MINIMUM_DEBT is 500

    let amount: bigint;
    if (borrowedAmount <= BigInt(0)) {
            throw new Error("Safe has no debt to repay.");
    }

    if (sbdBalance <= BigInt(0)) {
        throw new Error("Account has no SBD to repay with");
    }

    const maxRepayableAmount = borrowedAmount > sbdBalance ? sbdBalance : borrowedAmount

    if (borrowedAmount <= sbdBalance) {
      // If the borrowed amount is less than the sbd balance, we can repay the whole amount
      if (borrowedAmount > minimumDebt) {
          const maxRepayable = borrowedAmount;
          if (maxRepayable <= BigInt(0)) {
              amount = borrowedAmount;
          } else {
              const diff = borrowedAmount - minimumDebt
              if (diff > BigInt(0)) {
                  amount = (BigInt(context.prng.next()) % diff) + minimumDebt;
              } else {
                  amount = borrowedAmount //exactly the min debt
              }

          }
        
      } else {
        amount = borrowedAmount;
      }
    } else {
        if (sbdBalance > minimumDebt) {
            amount = (BigInt(context.prng.next()) % (sbdBalance-minimumDebt)) + minimumDebt; //ensure at least min debt after repay
        } else {
            amount = sbdBalance; //repay all of sbd balance
        }
      
    }

    if (amount > borrowedAmount) {
      amount = borrowedAmount;
    }

      if (amount > sbdBalance) {
          amount = sbdBalance;
      }

    if (amount <= BigInt(0)) {
      throw new Error('Repayment amount must be greater than zero.');
    }

    const nearestSpotInLiquidationQueue = 0; // or find from contract

    const actionParams = [
      BigInt(safeId),
      amount,
      BigInt(nearestSpotInLiquidationQueue),
    ];

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const signer = actor.account.value as ethers.Signer;
    const tx = await this.contract.connect(signer).repay(
      actionParams[0],
      actionParams[1],
      actionParams[2]
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

    const initialStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const finalStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const initialDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const finalDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const initialSafesOrderedForLiquidation = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const initialSafesOrderedForRedemption = previousSnapshot.contractSnapshot.safesOrderedForRedemption;

    const userAddress = actor.account.address;

    const initialSafe = initialStableBaseCDPSnapshot.safes[safeId];
    const finalSafe = finalStableBaseCDPSnapshot.safes[safeId];

    const initialTotalDebt = initialStableBaseCDPSnapshot.totalDebt;
    const finalTotalDebt = finalStableBaseCDPSnapshot.totalDebt;

    const initialSBDBalance = initialDFIDTokenSnapshot.Balance[userAddress] || BigInt(0);
    const finalSBDBalance = finalDFIDTokenSnapshot.Balance[userAddress] || BigInt(0);
    const initialTotalSupply = initialDFIDTokenSnapshot.TotalSupply;
    const finalTotalSupply = finalDFIDTokenSnapshot.TotalSupply;
    const initialTotalBurned = initialDFIDTokenSnapshot.TotalBurned;
    const finalTotalBurned = finalDFIDTokenSnapshot.TotalBurned;

    const minimumDebt = BigInt(500);

    if (!initialSafe) {
      throw new Error('Initial safe not found for safeId: ' + safeId);
    }

    const initialLiquidationSnapshot = initialStableBaseCDPSnapshot.liquidationSnapshots[safeId];
    const cumulativeCollateralPerUnitCollateral = initialStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral;

    let debtChange = initialSafe.borrowedAmount - finalSafe.borrowedAmount;

    if (initialLiquidationSnapshot && initialLiquidationSnapshot.collateralPerCollateralSnapshot != cumulativeCollateralPerUnitCollateral) {
      expect(finalSafe.borrowedAmount).to.be.closeTo(
        initialSafe.borrowedAmount - amount,
        Number(amount / BigInt(1000000000000000000))
      );
    } else {
      expect(finalSafe.borrowedAmount).to.equal(initialSafe.borrowedAmount - amount);
    }

    // Verify totalDebt decreased by amount (accounting for _updateSafe)
    expect(finalTotalDebt).to.be.closeTo(
      initialTotalDebt - amount,
      Number(amount / BigInt(1000000000000000000))
    );

    // Confirm final borrowedAmount is either 0 or >= MINIMUM_DEBT
    expect(finalSafe.borrowedAmount === BigInt(0) || finalSafe.borrowedAmount >= minimumDebt).to.be
      .true;

    if (finalSafe.borrowedAmount === BigInt(0)) {\n      if (initialSafesOrderedForLiquidation.nodes[safeId]) {
          expect(initialSafesOrderedForLiquidation.nodes[safeId]).to.be.undefined;
      }
      if (initialSafesOrderedForRedemption.nodes[safeId]) {
          expect(initialSafesOrderedForRedemption.nodes[safeId]).to.be.undefined;
      }
      
    }

    // Verify user's SBD balance decreased by amount
    expect(finalSBDBalance).to.equal(initialSBDBalance - amount);

    // Verify total SBD supply decreased by amount
    expect(finalTotalSupply).to.equal(initialTotalSupply - amount);

    // Verify total burned increased by amount
    expect(finalTotalBurned).to.equal(initialTotalBurned + amount);

    //check for protocol mode change
    if (initialTotalDebt > BigInt(1000) && initialStableBaseCDPSnapshot.mode === 0) {\n      expect(finalStableBaseCDPSnapshot.mode).to.equal(1);
    }

    //Verify that collateral updates are correctly updated when drift occurs
    if (
      initialLiquidationSnapshot &&
      initialLiquidationSnapshot.collateralPerCollateralSnapshot !=
        cumulativeCollateralPerUnitCollateral
    ) {
      expect(finalStableBaseCDPSnapshot.totalCollateral).to.be.gte(
        initialStableBaseCDPSnapshot.totalCollateral
      );
    }

    return true;
  }
}
