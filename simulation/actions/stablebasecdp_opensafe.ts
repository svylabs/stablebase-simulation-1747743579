import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class OpenSafeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("OpenSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot: any = currentSnapshot.contractSnapshot.stableBaseCDP;
    const accountBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const _safeId = BigInt(Math.floor(context.prng.next() % 100000) + 1); // Generate a random safeId
    let _amount = BigInt(Math.floor(context.prng.next() % 100) + 1); // Generate a random amount, but make sure its less than accountBalance

    // make sure that amount is less than accountBalance
    if (_amount > accountBalance) {
        _amount = accountBalance > 0n ? accountBalance : 1n;
    }

    if (stableBaseCDPSnapshot.safes[_safeId] !== undefined) {
        // Safe id already exists
        return [false, {}, {}];
    }

    //check the balance of account and see if it can afford this, otherwise reduce the amount.
    if (accountBalance < _amount) {
        if (accountBalance == 0n) {
          return [false, {}, {}];
        }
        _amount = accountBalance; //set to max amount that the account can afford.
    }

    const canExecute = _amount > 0n && stableBaseCDPSnapshot.safes[_safeId] === undefined;

    const actionParams = {
      _safeId: _safeId,
      _amount: _amount
    };

    const newIdentifiers = {
      safeId: _safeId.toString()
    };

    return [canExecute, actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const {
      _safeId,
      _amount
    } = actionParams;

    const tx = await this.contract.connect(actor.account.value).openSafe(_safeId, _amount, { value: _amount });
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
    const {
      _safeId,
      _amount
    } = actionParams;

    const stableBaseCDPPrevious: any = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew: any = newSnapshot.contractSnapshot.stableBaseCDP;
    const accountPreviousBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const accountNewBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    // Safe Existence
    expect(stableBaseCDPNew.safes[_safeId].collateralAmount).to.equal(_amount, "safes[_safeId].collateralAmount should be equal to _amount");
    expect(stableBaseCDPNew.safes[_safeId].borrowedAmount).to.equal(0n, "safes[_safeId].borrowedAmount should be equal to 0");
    expect(stableBaseCDPNew.safes[_safeId].weight).to.equal(0n, "safes[_safeId].weight should be equal to 0");
    expect(stableBaseCDPNew.safes[_safeId].totalBorrowedAmount).to.equal(0n, "safes[_safeId].totalBorrowedAmount should be equal to 0");
    expect(stableBaseCDPNew.safes[_safeId].feePaid).to.equal(0n, "safes[_safeId].feePaid should be equal to 0");

    // NFT Ownership - accessing safeOwners instead of _ownerOf since _ownerOf is internal
    expect(stableBaseCDPNew.safeOwners[_safeId]).to.equal(actor.account.address, "_ownerOf(_safeId) should be equal to msg.sender");

    //  NFT balance validation: token balances are tracked inside the contract
    const previousTokenBalance = stableBaseCDPPrevious.accountBalances[actor.account.address] || BigInt(0);
    const newTokenBalance = stableBaseCDPNew.accountBalances[actor.account.address] || BigInt(0);
    expect(newTokenBalance - previousTokenBalance).to.equal(1n, "NFT balance should increase by 1");

    // Collateral Value
    expect(stableBaseCDPNew.totalCollateral - stableBaseCDPPrevious.totalCollateral).to.equal(_amount, "totalCollateral should be increased by _amount");

    // Liquidation Snapshot
    expect(stableBaseCDPNew.liquidationSnapshots[_safeId].debtPerCollateralSnapshot).to.equal(stableBaseCDPPrevious.cumulativeDebtPerUnitCollateral, "liquidationSnapshots[_safeId].debtPerCollateralSnapshot should be equal to cumulativeDebtPerUnitCollateral before the function call");
    expect(stableBaseCDPNew.liquidationSnapshots[_safeId].collateralPerCollateralSnapshot).to.equal(stableBaseCDPPrevious.cumulativeCollateralPerUnitCollateral, "liquidationSnapshots[_safeId].collateralPerCollateralSnapshot should be equal to cumulativeCollateralPerUnitCollateral before the function call");

     // Account balance validation: account balance should be decremented by the _amount
     expect(accountNewBalance - accountPreviousBalance).to.equal(-_amount, 'Account balance should decrease by amount');

    return true;
  }
}
