import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class OpensafeAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("OpenSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const accountBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    // Generate parameters
    let _safeId: bigint;
    let _amount: bigint;
    let canExecute = false;

    // Find a unique safeId.  This is a naive approach, and could be improved
    // in a real implementation.
    let safeIdCounter = 1;
    while (true) {
      _safeId = BigInt(safeIdCounter);
      const safeExists = currentSnapshot.contractSnapshot.stableBaseCDP.safes?.[_safeId.toString()];

      if (!safeExists) {
        break;
      }
      safeIdCounter++;
    }

    _amount = BigInt(context.prng.next()) % (accountBalance / BigInt(2)) + BigInt(1);

    if (_amount > accountBalance) {
        return [false, {}, {}];
    }

    // Check if the safe already exists
    try {
        const safe = await this.contract.safes(_safeId);
        if (safe.collateralAmount > 0) {
            return [false, {}, {}];
        }
    } catch (error) {
       //if the safe does not exists in the blockchain, continue with execution
    }

    // Check if the owner already exists
    try {
        const owner = await this.contract._ownerOf(_safeId);
        if (owner !== ethers.ZeroAddress) {
            return [false, {}, {}];
        }
    } catch (error) {
         //if the owner does not exists in the blockchain, continue with execution
    }

    canExecute = true;    
    const actionParams = {
      _safeId: _safeId,
      _amount: _amount,
    };

    const newIdentifiers = {
      safeId: _safeId.toString(),
    };

    return [canExecute, actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract
      .connect(actor.account.value)
      .openSafe(actionParams._safeId, actionParams._amount, { value: actionParams._amount });
    const receipt = await tx.wait();
    return { receipt };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const _safeId = actionParams._safeId;
    const _amount = actionParams._amount;

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral || BigInt(0);
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral || BigInt(0);

    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt || BigInt(0);
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt || BigInt(0);

    // Safe Existence
    expect(newStableBaseCDPSnapshot.safes[_safeId.toString()].collateralAmount).to.equal(_amount);
    expect(newStableBaseCDPSnapshot.safes[_safeId.toString()].borrowedAmount).to.equal(BigInt(0));
    expect(newStableBaseCDPSnapshot.safes[_safeId.toString()].weight).to.equal(BigInt(0));
    expect(newStableBaseCDPSnapshot.safes[_safeId.toString()].totalBorrowedAmount).to.equal(BigInt(0));
    expect(newStableBaseCDPSnapshot.safes[_safeId.toString()].feePaid).to.equal(BigInt(0));

    // NFT Ownership
    expect(await this.contract._ownerOf(_safeId)).to.equal(actor.account.address);
    const previousBalance = previousSnapshot.contractSnapshot.stableBaseCDP._balances?.[actor.account.address] || BigInt(0);
    const newBalance = newSnapshot.contractSnapshot.stableBaseCDP._balances?.[actor.account.address] || BigInt(0);
    expect(newBalance - previousBalance).to.equal(BigInt(1));

    // Collateral Value
    expect(newTotalCollateral - previousTotalCollateral).to.equal(_amount);

    // Liquidation Snapshot
    expect(newStableBaseCDPSnapshot.liquidationSnapshots[_safeId.toString()].debtPerCollateralSnapshot).to.equal(previousStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral);
    expect(newStableBaseCDPSnapshot.liquidationSnapshots[_safeId.toString()].collateralPerCollateralSnapshot).to.equal(previousStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral);

    // Account balance validation
    expect(previousAccountBalance - newAccountBalance).to.equal(_amount);

    // Total collateral and debt validation
    expect(newTotalCollateral).to.equal(previousTotalCollateral + _amount);

    return true;
  }
}
