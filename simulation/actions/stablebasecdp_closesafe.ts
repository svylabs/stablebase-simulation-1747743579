import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { expect } from 'chai';
import { StableBaseCDPSnapshot, Safe } from "./generated/snapshot";

export class CloseSafeAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("CloseSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any[], Record<string, any>]> {
    const safeId = BigInt(actor.identifiers.safeId);

    // Check if safeId exists in the current snapshot and is owned by the actor
    const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safe = stableBaseCDP.safes[safeId];
    if (!safe) {
      throw new Error(`Safe with ID ${safeId} does not exist`);
    }

    const ownerOfSafe = stableBaseCDP.ownerOf[safeId];
    if (ownerOfSafe !== actor.account.address) {
      throw new Error(`Actor is not the owner of Safe with ID ${safeId}`);
    }

    // Ensure the safe has no outstanding debt
    if (safe.borrowedAmount !== BigInt(0)) {
      throw new Error(`Safe with ID ${safeId} has outstanding debt`);
    }

    return [[safeId], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const safeId = actionParams[0];
    const tx = await this.contract.connect(actor.account.value).closeSafe(safeId);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const safeId = actionParams[0];

    const stableBaseCDPPrevious: StableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew: StableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    // Safe Closure
    expect(stableBaseCDPNew.safes[safeId]).to.be.undefined; // or return default values

    const previousSafe: Safe = stableBaseCDPPrevious.safes[safeId];
    if (!previousSafe) {
      throw new Error(`Safe with ID ${safeId} not found in previous snapshot`);
    }

    const collateralAmount = previousSafe.collateralAmount;
    expect(stableBaseCDPNew.totalCollateral).to.eq(stableBaseCDPPrevious.totalCollateral - collateralAmount, "Total collateral should be decreased by the collateralAmount of the closed Safe.");

    // NFT Burning
    expect(stableBaseCDPNew.ownerOf[safeId]).to.eq(ethers.ZeroAddress, "The NFT corresponding to the safeId should be burned");

    // Validate balances
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    // Assuming collateralAmount is transferred to the actor's account
    expect(newAccountBalance).to.be.gte(previousAccountBalance + collateralAmount, 'Account balance should increase by at least the collateral amount');

    // Validate totalDebt remains the same (accounting for potential increases in _updateSafe)
    const totalDebtPrevious = stableBaseCDPPrevious.totalDebt;
    const totalDebtNew = stableBaseCDPNew.totalDebt;
    expect(totalDebtNew).to.gte(totalDebtPrevious, "Total debt should remain the same or increase due to cumulative updates");

    // Validate that totalBorrowedAmount is zero after closing the safe. Since safe is deleted it is not possible to check directly.
    // Need to validate this through events emitted by the contract.

    return true;
  }
}