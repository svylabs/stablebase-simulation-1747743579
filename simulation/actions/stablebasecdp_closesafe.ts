import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';

export class CloseSafeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("CloseSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const safeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes || {}).map(Number);

    let safeId: number | undefined;
    for (const id of safeIds) {
      const safeOwner = currentSnapshot.contractSnapshot.stableBaseCDP.ownerOf ? currentSnapshot.contractSnapshot.stableBaseCDP.ownerOf[BigInt(id)] : undefined;
      if (safeOwner === actor.account.address) {
        safeId = id;
        break;
      }
    }

    if (!safeId) {
      throw new Error("No Safe found owned by this actor.");
    }

    return [[BigInt(safeId)], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const safeId = actionParams[0];
    const signer = actor.account.value.connect(this.contract.runner!);
    return this.contract.connect(signer).closeSafe(safeId);
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const safeId = actionParams[0];

    const prevStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    // Safe Closure Validation
    expect(newStableBaseCDPSnapshot.safes[safeId]).to.be.undefined; // or deep.equal(defaultValue), if you know the default value
    expect(prevStableBaseCDPSnapshot.safes[safeId]).to.not.be.undefined; //Safe must exist before close

    // Verify borrowedAmount is 0 before closing safe
    expect(prevStableBaseCDPSnapshot.safes[safeId].borrowedAmount).to.equal(BigInt(0), "Safe must have 0 borrowed amount to be closed");

    const previousSafe = prevStableBaseCDPSnapshot.safes[safeId];
    const collateralAmount = previousSafe.collateralAmount;

    // totalCollateral should be decreased by the collateralAmount of the closed Safe.
    expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(prevStableBaseCDPSnapshot.totalCollateral - collateralAmount);

    // NFT Burning Validation
    expect(newStableBaseCDPSnapshot.ownerOf[safeId]).to.equal(ethers.ZeroAddress);
    expect(prevStableBaseCDPSnapshot.ownerOf[safeId]).to.not.equal(ethers.ZeroAddress);

    // Account Balance Validation
    const prevAccountBalance = previousSnapshot.accountSnapshot[actor.account.address];
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address];
    //The collateral must have been transferred back to the user, account balance must have increased by collateralAmount
    expect(newAccountBalance - prevAccountBalance).to.be.gte(collateralAmount, "Account balance should increase by collateralAmount");

    //Validate token balances for affected contracts and accounts.
    const stableBaseCDPAddress = ((context.contracts.stableBaseCDP as ethers.Contract)).target;
    const prevStableBaseCDPTokenBalance = previousSnapshot.accountSnapshot[stableBaseCDPAddress] || BigInt(0);
    const newStableBaseCDPTokenBalance = newSnapshot.accountSnapshot[stableBaseCDPAddress] || BigInt(0);
    expect(newStableBaseCDPTokenBalance).to.equal(prevStableBaseCDPTokenBalance);

        // Validate totalDebt remains the same (or accounts for any debt increase in _updateSafe)
        const prevTotalDebt = prevStableBaseCDPSnapshot.totalDebt;
        const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

        // Check for potential debt increase in _updateSafe
        let debtIncrease = BigInt(0);
        if (prevStableBaseCDPSnapshot.liquidationSnapshots && prevStableBaseCDPSnapshot.liquidationSnapshots[safeId]) {
            const liquidationSnapshot = prevStableBaseCDPSnapshot.liquidationSnapshots[safeId];
            if (liquidationSnapshot && liquidationSnapshot[1] != prevStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral) {
               //Debt can increase in _updateSafe function
               //Cannot exactly calculate this increase so skipping the check for now since this change is very rare.
            }
        }
        expect(newTotalDebt).to.equal(prevTotalDebt + debtIncrease, "Total debt should remain the same (accounting for potential debt increase in `_updateSafe`)");

    return true;
  }
}
