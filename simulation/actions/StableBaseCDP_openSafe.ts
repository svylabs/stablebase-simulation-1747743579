import { ethers } from "ethers";
import { Action, Actor, RunContext, Snapshot } from "@/index";

export class StableBaseCDPOpenSafeAction implements Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Generate _safeId: Ensure it's greater than 0 and doesn't already exist.
    let _safeId: bigint;
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loops
    do {
      _safeId = BigInt(context.prng.next()) + 1n; // Ensure it's greater than 0
      const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId];

      const owner = currentSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId];
      if (safe === undefined && owner === undefined) {
        break; // Safe ID is available
      }
      attempts++;
      if (attempts > maxAttempts) {
        throw new Error("Could not generate a unique _safeId after multiple attempts.");
      }
    } while (true);

    // Generate _amount:  Greater than 0, represents the collateral amount.
    // Use a fraction of the actor's available Ether as a maximum.
    const maxEth = (BigInt(context.prng.next()) * actor.account.value.getBalance )/ 4294967296n; // Arbitrary limit.  Should be based on actor's eth balance
    const _amount = maxEth > 0n ? maxEth : 1000000000000000000n; // Ensure it's greater than 0, default to 1 ether

    const params = [_safeId];
    const overrides = { value: _amount };
    const actionParams = [_safeId, overrides];

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
    const [safeId, overrides] = actionParams;

    try {
      const tx = await this.contract
        .connect(actor.account.value as ethers.Signer)
        .openSafe(safeId, overrides);
      await tx.wait();
    } catch (error) {
      console.error("Error executing openSafe:", error);
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
    const [safeId, overrides] = actionParams;
    const _amount = overrides.value;

    // Safe State
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];
    if (newSafe.collateralAmount !== _amount) {
      console.error("Validation failed: safes[_safeId].collateralAmount != _amount");
      return false;
    }
    if (newSafe.borrowedAmount !== 0n) {
      console.error("Validation failed: safes[_safeId].borrowedAmount != 0");
      return false;
    }
    if (newSafe.weight !== 0n) {
      console.error("Validation failed: safes[_safeId].weight != 0");
      return false;
    }
    if (newSafe.totalBorrowedAmount !== 0n) {
      console.error("Validation failed: safes[_safeId].totalBorrowedAmount != 0");
      return false;
    }
    if (newSafe.feePaid !== 0n) {
      console.error("Validation failed: safes[_safeId].feePaid != 0");
      return false;
    }

    const newLiquidationSnapshot = newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId];
    if (
      newLiquidationSnapshot.debtPerCollateralSnapshot !==
      newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral
    ) {
      console.error("Validation failed: liquidationSnapshots[_safeId].debtPerCollateralSnapshot != cumulativeDebtPerUnitCollateral");
      return false;
    }
    if (
      newLiquidationSnapshot.collateralPerCollateralSnapshot !==
      newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral
    ) {
      console.error("Validation failed: liquidationSnapshots[_safeId].collateralPerCollateralSnapshot != cumulativeCollateralPerUnitCollateral");
      return false;
    }

    // NFT Ownership
    if (
      newSnapshot.contractSnapshot.stableBaseCDP.owners[safeId] !==
      actor.account.address
    ) {
      console.error("Validation failed: _ownerOf(_safeId) != msg.sender");
      return false;
    }

    // Global State
    if (
      newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral -
        previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral !==
      _amount
    ) {
      console.error("Validation failed: totalCollateral has not increased by _amount");
      return false;
    }

    // Event verification would ideally be done here. Due to limitations with
    // accessing events from the snapshot, this verification is skipped. In a
    // complete implementation, you would read the events emitted during the
    // transaction and verify that an `OpenSafe` event was emitted with the
    // correct parameters (`_safeId`, `msg.sender`, `_amount`, `totalCollateral`, `totalDebt`).

    return true;
  }
} 