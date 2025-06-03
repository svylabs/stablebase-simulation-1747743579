import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

class OpenSafeAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("OpenSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Generate _safeId
    let _safeId: bigint;
    let safeIdExists = true;
    let attempts = 0;
    const maxAttempts = 100;

    // Get existing safe ids for the actor
    const existingSafeIds = actor.getIdentifiers().map((id) => BigInt(id));

    do {
      if (attempts >= maxAttempts) {
        throw new Error("Could not generate a unique _safeId after multiple attempts.");
      }
      _safeId = BigInt(Math.floor(context.prng.next() % 1000000) + 1); // Ensure _safeId > 0

      // Check if the safeId exists in the current snapshot
      if (currentSnapshot.contractSnapshot.stableBaseCDP.safes && currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId]) {
        safeIdExists = currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].collateralAmount !== BigInt(0); // Check collateralAmount
      } else {
        safeIdExists = false;
      }

      // Check if _safeId is present in existingSafeIds for the actor
      if (existingSafeIds.includes(_safeId)) {
        safeIdExists = true;
      }

      attempts++;
    } while (safeIdExists);

    // Generate _amount
    const _amount = BigInt(Math.floor(context.prng.next() % 1000) + 1); // Ensure _amount > 0

    const actionParams = [_safeId, _amount];
    const newIdentifiers = { _safeId: _safeId.toString() };

    return [actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const _safeId = actionParams[0];
    const _amount = actionParams[1];

    const tx = await this.contract.connect(actor.account.value).openSafe(_safeId, _amount, { value: _amount });
    await tx.wait();

    return;
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const _safeId = actionParams[0];
    const _amount = actionParams[1];
    const actorAddress = actor.account.address;

    // Verify that safes[_safeId].collateralAmount is equal to the _amount provided.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].collateralAmount).to.equal(_amount, "Incorrect collateralAmount");

    // Verify that safes[_safeId].borrowedAmount is 0.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].borrowedAmount).to.equal(BigInt(0), "Incorrect borrowedAmount");

    // Verify that safes[_safeId].weight is 0.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].weight).to.equal(BigInt(0), "Incorrect weight");

    // Verify that safes[_safeId].totalBorrowedAmount is 0.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].totalBorrowedAmount).to.equal(BigInt(0), "Incorrect totalBorrowedAmount");

    // Verify that safes[_safeId].feePaid is 0.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].feePaid).to.equal(BigInt(0), "Incorrect feePaid");

    // Verify that liquidationSnapshots[_safeId].debtPerCollateralSnapshot is equal to cumulativeDebtPerUnitCollateral.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId].debtPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral, "Incorrect debtPerCollateralSnapshot");

    // Verify that liquidationSnapshots[_safeId].collateralPerCollateralSnapshot is equal to cumulativeCollateralPerUnitCollateral.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId].collateralPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral, "Incorrect collateralPerCollateralSnapshot");

    // Verify that _ownerOf(_safeId) returns msg.sender.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId]).to.equal(actorAddress, "Incorrect owner");

    // Verify that totalCollateral has increased by _amount.
    expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral).to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral + _amount, "Incorrect totalCollateral");

    //Additional Checks
    if(previousSnapshot.contractSnapshot.stableBaseCDP.balances){
      expect(newSnapshot.contractSnapshot.stableBaseCDP.balances[actorAddress]).to.equal((previousSnapshot.contractSnapshot.stableBaseCDP.balances[actorAddress] || BigInt(0)) + BigInt(1), "Incorrect balance");
    } else {
      expect(newSnapshot.contractSnapshot.stableBaseCDP.balances[actorAddress]).to.equal(BigInt(1), "Incorrect balance");
    }

    return true;
  }
}

export default OpenSafeAction;
