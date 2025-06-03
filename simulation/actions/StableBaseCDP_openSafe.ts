import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@/ilumia";

export class StableBaseCDPOpensafeAction implements Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Generate _safeId
    let _safeId: bigint;
    let maxRetries = 100; // avoid infinite loops
    while (maxRetries > 0) {
      _safeId = BigInt(Math.floor(context.prng.next() % 1000000) + 1); // Ensure it's greater than 0

      const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes?.[_safeId];
      const owner = currentSnapshot.contractSnapshot.stableBaseCDP.owners?.[_safeId];

      if ((safe === undefined || safe.collateralAmount === 0n) && (owner === undefined || owner === ethers.ZeroAddress)) {
        break; // Found a suitable safeId
      }
      maxRetries--;
    }

    if (maxRetries === 0) {
      throw new Error("Could not generate a unique _safeId after multiple retries.");
    }

    // Generate _amount
    const _amount = BigInt(Math.floor(context.prng.next() % 1000) + 1); // Ensure it's greater than 0

    const actionParams = { _safeId: _safeId, _amount: _amount, value: _amount };
    const newIdentifiers = { _safeId: _safeId };

    return [actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { _safeId, _amount, value } = actionParams;

    try {
      const tx = await this.contract.connect(actor.account.value).openSafe(_safeId, { value: value });
      await tx.wait();
    } catch (error: any) {
      console.error("Execution error:", error);
      throw error;
    }
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const { _safeId, _amount } = actionParams;

    // Safe State
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].collateralAmount !== _amount) {
      console.error("Validation failed: safes[_safeId].collateralAmount !== _amount");
      return false;
    }
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].borrowedAmount !== 0n) {
      console.error("Validation failed: safes[_safeId].borrowedAmount !== 0");
      return false;
    }
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].weight !== 0n) {
      console.error("Validation failed: safes[_safeId].weight !== 0");
      return false;
    }
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].totalBorrowedAmount !== 0n) {
      console.error("Validation failed: safes[_safeId].totalBorrowedAmount !== 0");
      return false;
    }
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].feePaid !== 0n) {
      console.error("Validation failed: safes[_safeId].feePaid !== 0");
      return false;
    }

    if (newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId].debtPerCollateralSnapshot !==
      newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral) {
      console.error("Validation failed: liquidationSnapshots[_safeId].debtPerCollateralSnapshot !== cumulativeDebtPerUnitCollateral");
      return false;
    }

    if (newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId].collateralPerCollateralSnapshot !==
      newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral) {
      console.error("Validation failed: liquidationSnapshots[_safeId].collateralPerCollateralSnapshot !== cumulativeCollateralPerUnitCollateral");
      return false;
    }

    // NFT Ownership
    if (ethers.getAddress(newSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId]) !== ethers.getAddress(actor.account.address)) {
      console.error("Validation failed: _ownerOf(_safeId) !== msg.sender");
      return false;
    }

    // Global State
    if (newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral !== previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral + _amount) {
      console.error("Validation failed: totalCollateral has not increased by _amount");
      return false;
    }

    // TODO: Verify OpenSafe event.  Need better event parsing in Ilumia.

    return true;
  }
}
