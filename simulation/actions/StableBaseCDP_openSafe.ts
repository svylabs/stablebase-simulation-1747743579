import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia'
import { ethers } from 'ethers'
import { expect } from 'chai'

export class OpenSafeAction extends Action {
  private contract: ethers.Contract

  constructor(contract: ethers.Contract) {
    super('OpenSafeAction')
    this.contract = contract
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Generate a `_safeId` greater than 0 that does not already exist
    let _safeId: bigint
    let safeExists = true
    let attempts = 0
    const maxAttempts = 100 // Avoid infinite loops

    while (safeExists && attempts < maxAttempts) {
      _safeId = BigInt(context.prng.next()) % BigInt(1000) + BigInt(1)

      const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes?.[_safeId]
      const owner = currentSnapshot.contractSnapshot.stableBaseCDP.owners?.[_safeId]

      safeExists = (safe !== undefined && safe.collateralAmount !== BigInt(0)) || (owner !== undefined && owner !== ethers.ZeroAddress)
      attempts++
    }

    if (safeExists) {
      throw new Error('Could not generate a unique safeId after multiple attempts.')
    }

    // Generate an `_amount` greater than 0
    const _amount = BigInt(context.prng.next()) % (actor.account.value ? BigInt(ethers.parseEther('10')) : BigInt(10)) + BigInt(1)

    const params = [_safeId, _amount]

    const newIdentifiers = {
      _safeId: _safeId.toString()
    }

    return [params, newIdentifiers]
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [safeId, amount] = actionParams

    try {
      const tx = await this.contract
        .connect(actor.account.value as ethers.Signer)
        .openSafe(safeId, amount, { value: amount })
      await tx.wait()
    } catch (error) {
      console.error('Transaction execution failed:', error)
      throw error; // Re-throw the error to indicate failure
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const [safeId, amount] = actionParams
    const safeIdBigInt = BigInt(safeId)

    // Safe State
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[safeIdBigInt].collateralAmount,
      'collateralAmount should be equal to _amount'
    ).to.equal(BigInt(amount))
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[safeIdBigInt].borrowedAmount,
      'borrowedAmount should be 0'
    ).to.equal(BigInt(0))
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[safeIdBigInt].weight,
      'weight should be 0'
    ).to.equal(BigInt(0))
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[safeIdBigInt].totalBorrowedAmount,
      'totalBorrowedAmount should be 0'
    ).to.equal(BigInt(0))
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.safes[safeIdBigInt].feePaid,
      'feePaid should be 0'
    ).to.equal(BigInt(0))
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeIdBigInt]
        .debtPerCollateralSnapshot,
      'debtPerCollateralSnapshot should be equal to cumulativeDebtPerUnitCollateral'
    ).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral)
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeIdBigInt]
        .collateralPerCollateralSnapshot,
      'collateralPerCollateralSnapshot should be equal to cumulativeCollateralPerUnitCollateral'
    ).to.equal(
      newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral
    )

    // NFT Ownership
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.owners[safeIdBigInt],
      'ownerOf(_safeId) should return msg.sender'
    ).to.equal(actor.account.address)

    // Global State
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral - previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral,
      'totalCollateral should have increased by _amount'
    ).to.equal(BigInt(amount))

        // Account Balances (ETH)
        const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newEthBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const ethChange = previousEthBalance - newEthBalance;
        expect(ethChange, 'ETH balance should have decreased by amount sent + gas cost').to.be.greaterThanOrEqual(BigInt(amount));

        // Contract Balance (ETH)
        const previousContractEthBalance = previousSnapshot.accountSnapshot[this.contract.address] || BigInt(0);
        const newContractEthBalance = newSnapshot.accountSnapshot[this.contract.address] || BigInt(0);
        const contractEthChange = newContractEthBalance - previousContractEthBalance;
        expect(contractEthChange, 'Contract ETH balance should have increased by amount sent').to.equal(BigInt(amount));

    // Token Balances: No tokens involved in this function

    return true
  }
}
