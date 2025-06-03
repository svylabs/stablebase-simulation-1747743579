import { ethers } from 'ethers';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { expect } from 'chai';

export class OpenSafeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('OpenSafeAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    let _safeId: bigint;
    let maxSafeId = 100;
    let attempts = 0;

    while (true) {
      if (attempts > maxSafeId * 2) {
        throw new Error("Could not find a valid safeId after multiple attempts.");
      }
      _safeId = BigInt(Math.floor(context.prng.next() % BigInt(maxSafeId) + 1));

      const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId];
      const owner = currentSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId];

      if ((safe === undefined || safe.collateralAmount === BigInt(0)) && (owner === undefined || owner === ethers.ZeroAddress)) {
        break;
      }
      attempts++;
    }

    const _amount = BigInt(Math.floor(context.prng.next() % BigInt(1000) + 1)); // Example amount between 1 and 1000

    const newIdentifiers: Record<string, any> = {
      _safeId: _safeId.toString(),
    };

    const actionParams = [
      _safeId,
      _amount,
    ];

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

    try {
      const tx = await this.contract
        .connect(actor.account.value)
        .openSafe(_safeId, _amount, { value: _amount });

      await tx.wait();
    } catch (error: any) {
      throw new Error(`Error executing openSafe: ${_safeId}, ${_amount}. Details: ${error.message}`);
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const _safeId = actionParams[0] as bigint;
    const _amount = actionParams[1] as bigint;

    // Safe State
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].collateralAmount,
      'collateralAmount should be equal to _amount'
    ).to.equal(_amount);
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].borrowedAmount,
      'borrowedAmount should be 0'
    ).to.equal(BigInt(0));
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].weight,
      'weight should be 0'
    ).to.equal(BigInt(0));
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].totalBorrowedAmount,
      'totalBorrowedAmount should be 0'
    ).to.equal(BigInt(0));
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].feePaid,
      'feePaid should be 0'
    ).to.equal(BigInt(0));
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId]
        .debtPerCollateralSnapshot,
      'debtPerCollateralSnapshot should be equal to cumulativeDebtPerUnitCollateral'
    ).to.equal(
      newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral
    );
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId]
        .collateralPerCollateralSnapshot,
      'collateralPerCollateralSnapshot should be equal to cumulativeCollateralPerUnitCollateral'
    ).to.equal(
      newSnapshot.contractSnapshot.stableBaseCDP
        .cumulativeCollateralPerUnitCollateral
    );

    // NFT Ownership
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId],
      '_ownerOf(_safeId) should return msg.sender'
    ).to.equal(actor.account.address);

    // Global State
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral - previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral,
      'totalCollateral should have increased by _amount'
    ).to.equal(_amount);

    // Contract ETH balance validation
    const contractAddress = this.contract.target;
    if (contractAddress) {
        expect(
            (newSnapshot.accountSnapshot[contractAddress as string] || BigInt(0)) - (previousSnapshot.accountSnapshot[contractAddress as string] || BigInt(0)),
            'Contract ETH balance should have increased by _amount'
        ).to.equal(_amount);
    }

    // Token Balances
    const previousBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balances[actor.account.address] || BigInt(0);
    const newBalance = newSnapshot.contractSnapshot.stableBaseCDP.balances[actor.account.address] || BigInt(0);

    expect(
      newBalance,
      'Token balance of the owner should have increased by 1'
    ).to.equal(previousBalance + BigInt(1));

    return true;
  }
}
