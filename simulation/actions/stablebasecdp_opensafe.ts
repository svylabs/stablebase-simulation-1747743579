import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";

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
    let _safeId: bigint;
    let attempts = 0;
    const maxAttempts = 100; // avoid infinite loops

    do {
      _safeId = BigInt(context.prng.next());
      attempts++;
      if (attempts > maxAttempts) {
        throw new Error("Could not find a unique _safeId after multiple attempts.");
      }
    } while (
      _safeId <= 0 ||
      currentSnapshot.contractSnapshot.stableBaseCDP.safes?.[Number(_safeId)]?.collateralAmount !== 0n ||
      (currentSnapshot.contractSnapshot.stableBaseCDP.ownerOf?.[Number(_safeId)] !== undefined && currentSnapshot.contractSnapshot.stableBaseCDP.ownerOf?.[Number(_safeId)] !== ethers.constants.AddressZero)
    );

    // Ensure amount > 0, keep it relatively small, and within a reasonable bound
    const maxAmount = context.prng.next() % 1000 + 1;
    const _amount = BigInt(maxAmount);

    const actionParams = {
      _safeId: _safeId,
      _amount: _amount,
      value: _amount, // msg.value
    };

    const newIdentifiers = {
      _safeId: _safeId.toString(),
    };

    return [actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const {
      _safeId,
      _amount,
    } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .openSafe(_safeId, _amount, { value: BigInt(actionParams.value) });
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const {
      _safeId,
      _amount,
    } = actionParams;

    const safeIdNumber = Number(_safeId);

    // Safe State: Validating state changes in StableBaseCDP contract
    const prevTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    const newTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    expect(newSnapshot.contractSnapshot.stableBaseCDP.safes?.[safeIdNumber]?.collateralAmount).to.equal(_amount, "collateralAmount should match _amount");
    expect(newSnapshot.contractSnapshot.stableBaseCDP.safes?.[safeIdNumber]?.borrowedAmount).to.equal(0n, "borrowedAmount should be 0");
    expect(newTotalCollateral).to.equal(prevTotalCollateral + _amount, "totalCollateral should be increased by _amount");
    expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebt).to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt, "totalDebt should remain unchanged");

    // NFT Ownership: Validating state changes in ERC721Base (implicitly called by StableBaseCDP)
    expect(newSnapshot.contractSnapshot.stableBaseCDP.ownerOf?.[safeIdNumber]).to.equal(actor.account.address, "Owner of the NFT should be msg.sender");

    expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots?.[safeIdNumber]?.[0]).to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral, "cumulativeDebtPerUnitCollateral should be equal");
    expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots?.[safeIdNumber]?.[1]).to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral, "cumulativeCollateralPerUnitCollateral should be equal");

    // Account Balances: Cannot accurately validate since gas costs affect balance

    return true;
  }
}
