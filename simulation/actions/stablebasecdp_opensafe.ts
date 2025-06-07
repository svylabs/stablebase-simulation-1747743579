import { ethers } from 'ethers';
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';

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
  ): Promise<[any, Record<string, any>]> {
    // Generate a unique _safeId
    let _safeId: bigint;
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loops
    do {
      _safeId = BigInt(context.prng.next());
      if (_safeId <= 0) continue; // Safe ID must be greater than 0
      // check if safe already exists
      const safeExists = currentSnapshot.contractSnapshot.stableBaseCDP.safes && currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId] !== undefined;
      const ownerExists = currentSnapshot.contractSnapshot.stableBaseCDP.ownerOf && currentSnapshot.contractSnapshot.stableBaseCDP.ownerOf[_safeId] !== undefined;
      if (!safeExists && !ownerExists) break; // Exit loop if safe doesn't exist
      attempts++;
    } while (attempts < maxAttempts);

    if (attempts >= maxAttempts) {
      throw new Error("Failed to generate a unique Safe ID after multiple attempts.");
    }

    // Ensure _amount is less than available ETH but greater than 0
    const ethBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    let _amount = BigInt(context.prng.next()) % (ethBalance > BigInt(100) ? BigInt(100) : ethBalance);
    if (_amount <= 0) {
        _amount = BigInt(1); // Ensure _amount is at least 1 if the modulo operation results in 0
    }

    const actionParams = [_safeId, _amount];
    const newIdentifiers = { _safeId: _safeId };

    return [actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    // Validate actionParams types
    if (!Array.isArray(actionParams) || actionParams.length !== 2) {
        throw new Error("Invalid actionParams format. Expected an array of length 2.");
    }

    const _safeId = typeof actionParams[0] === 'bigint' ? actionParams[0] : BigInt(actionParams[0]);
    const _amount = typeof actionParams[1] === 'bigint' ? actionParams[1] : BigInt(actionParams[1]);

    // Call the openSafe function using the contract passed in the constructor
    const tx = await this.contract.connect(actor.account.value).openSafe(_safeId, _amount, { value: _amount });
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    // Validate actionParams types
    if (!Array.isArray(actionParams) || actionParams.length !== 2) {
        throw new Error("Invalid actionParams format. Expected an array of length 2 for validation.");
    }

    const _safeId = typeof actionParams[0] === 'bigint' ? actionParams[0] : BigInt(actionParams[0]);
    const _amount = typeof actionParams[1] === 'bigint' ? actionParams[1] : BigInt(actionParams[1]);

    const previousTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0);
    const previousTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt || BigInt(0);

    // Validate Safe data
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId];
    expect(newSafe.collateralAmount).to.equal(_amount, "safes[_safeId].collateralAmount should be equal to _amount");
    expect(newSafe.borrowedAmount).to.equal(BigInt(0), "safes[_safeId].borrowedAmount should be equal to 0");
    expect(newSafe.weight).to.equal(BigInt(0), "safes[_safeId].weight should be equal to 0");
    expect(newSafe.totalBorrowedAmount).to.equal(BigInt(0), "safes[_safeId].totalBorrowedAmount should be equal to 0");
    expect(newSafe.feePaid).to.equal(BigInt(0), "safes[_safeId].feePaid should be equal to 0");

    // Validate NFT Ownership
    expect(newSnapshot.contractSnapshot.stableBaseCDP.ownerOf[_safeId]).to.equal(actor.account.address, "_ownerOf(_safeId) should be equal to msg.sender");

    // Validate Liquidation Snapshot
    expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId].debtPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral, "liquidationSnapshots[_safeId].debtPerCollateralSnapshot should be equal to cumulativeDebtPerUnitCollateral");
    expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId].collateralPerCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral, "liquidationSnapshots[_safeId].collateralPerCollateralSnapshot should be equal to cumulativeCollateralPerUnitCollateral");

    // Validate Total Collateral and Debt
    expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral).to.equal(previousTotalCollateral + _amount, "totalCollateral should be increased by _amount");
    expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebt).to.equal(previousTotalDebt, "totalDebt should remain unchanged.");

    // Validate Account Balance
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    expect(newAccountBalance).to.equal(previousAccountBalance - _amount, "Account balance should be decreased by _amount");

    // Validate Event Emission
    const events = newSnapshot.events;
    let openSafeEventFound = false;
    if (events && events.StableBaseCDP) {
        for (const event of events.StableBaseCDP) {
            if (event.name === 'OpenSafe') {
                expect(event.args._safeId).to.equal(_safeId, 'OpenSafe event safeId mismatch');
                expect(event.args.owner).to.equal(actor.account.address, 'OpenSafe event owner mismatch');
                expect(event.args.amount).to.equal(_amount, 'OpenSafe event amount mismatch');
                expect(event.args.totalCollateral).to.equal(previousTotalCollateral + _amount, 'OpenSafe event totalCollateral mismatch');
                expect(event.args.totalDebt).to.equal(previousTotalDebt, 'OpenSafe event totalDebt mismatch');
                openSafeEventFound = true;
                break;
            }
        }
    }
    expect(openSafeEventFound).to.be.true, "OpenSafe event should be emitted";

    return true;
  }
}
