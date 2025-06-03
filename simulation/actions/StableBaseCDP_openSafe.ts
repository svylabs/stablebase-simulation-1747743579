import { Actor, RunContext, Snapshot, Action } from "@ilumina/core";
import { StableBaseCDPSnapshot } from "./types";
import { ethers } from "ethers";

export class StableBaseCDPOpenSafeAction implements Action {
  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot
      .stableBaseCDP as StableBaseCDPSnapshot;

    // Generate a _safeId that doesn't already exist
    let _safeId: bigint;
    let attempts = 0;
    const maxAttempts = 100; // Avoid infinite loops

    do {
      _safeId = BigInt(Math.floor(context.prng.next() % 10000) + 1); // Ensure > 0
      if (stableBaseCDPSnapshot.safes && stableBaseCDPSnapshot.safes[_safeId]) {

      } else if (stableBaseCDPSnapshot.owners && stableBaseCDPSnapshot.owners[_safeId.toString()] !== undefined) {

      } else {
        break;
      }
      attempts++;
      if (attempts >= maxAttempts) {
        throw new Error("Could not generate a unique _safeId after multiple attempts.");
      }
    } while (
      stableBaseCDPSnapshot.safes &&
      stableBaseCDPSnapshot.safes[_safeId] &&
      stableBaseCDPSnapshot.safes[_safeId].collateralAmount !== 0n
    );

    // Generate an _amount greater than 0
    const _amount = BigInt(Math.floor(context.prng.next() % 1000) + 1); // Ensure > 0

    const actionParams = {
      _safeId: _safeId,
      _amount: _amount,
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
    const contract = new ethers.Contract(
      context.addresses["StableBaseCDP"],
      [], // ABI not needed here for execution, can be omitted or left empty.
      actor.account.value
    );

    const tx = await contract.openSafe(actionParams._safeId, {
      value: actionParams._amount,
    });
    await tx.wait();

    return {}; // Return empty object if no specific return values needed
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot
      .stableBaseCDP as StableBaseCDPSnapshot;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot
      .stableBaseCDP as StableBaseCDPSnapshot;

    const _safeId = actionParams._safeId;
    const _amount = actionParams._amount;

    // Safe State
    if (
      !newStableBaseCDPSnapshot.safes ||
      !newStableBaseCDPSnapshot.safes[_safeId]
    ) {
      console.error("Safe not found in new snapshot");
      return false;
    }

    if (newStableBaseCDPSnapshot.safes[_safeId].collateralAmount !== _amount) {
      console.error("collateralAmount mismatch");
      return false;
    }
    if (newStableBaseCDPSnapshot.safes[_safeId].borrowedAmount !== 0n) {
      console.error("borrowedAmount not zero");
      return false;
    }
    if (newStableBaseCDPSnapshot.safes[_safeId].weight !== 0n) {
      console.error("weight not zero");
      return false;
    }
    if (newStableBaseCDPSnapshot.safes[_safeId].totalBorrowedAmount !== 0n) {
      console.error("totalBorrowedAmount not zero");
      return false;
    }
    if (newStableBaseCDPSnapshot.safes[_safeId].feePaid !== 0n) {
      console.error("feePaid not zero");
      return false;
    }

    if (
      !newStableBaseCDPSnapshot.liquidationSnapshots ||
      !newStableBaseCDPSnapshot.liquidationSnapshots[_safeId]
    ) {
      console.error("Liquidation snapshot not found in new snapshot");
      return false;
    }

    if (
      newStableBaseCDPSnapshot.liquidationSnapshots[_safeId]
        .debtPerCollateralSnapshot !==
      newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral
    ) {
      console.error("debtPerCollateralSnapshot mismatch");
      return false;
    }
    if (
      newStableBaseCDPSnapshot.liquidationSnapshots[_safeId]
        .collateralPerCollateralSnapshot !==
      newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral
    ) {
      console.error("collateralPerCollateralSnapshot mismatch");
      return false;
    }

    // NFT Ownership
    if (!newStableBaseCDPSnapshot.owners) {
        console.error("Owners mapping not found in new snapshot");
        return false;
    }

    if (newStableBaseCDPSnapshot.owners[String(_safeId)] !== actor.account.address) {
        console.error("Owner Mismatch", newStableBaseCDPSnapshot.owners, actor.account.address, _safeId);
        return false;
    }

    // Global State
    const expectedTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral + _amount;
    if (newStableBaseCDPSnapshot.totalCollateral !== expectedTotalCollateral) {\n      console.error("totalCollateral mismatch", newStableBaseCDPSnapshot.totalCollateral, expectedTotalCollateral);
      return false;
    }

    // TODO: Verify that a OpenSafe event is emitted with the correct parameters
    // Events are not directly available in snapshots.  Event validation would
    // typically involve access to transaction receipts or logs, which are
    // beyond the scope of snapshot-based validation.

    return true;
  }
}
