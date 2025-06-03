import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";

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
    // Generate _safeId
    let _safeId: bigint;
    let attempts = 0;
    const maxAttempts = 100; // Avoid infinite loops

    do {
      _safeId = BigInt(context.prng.next()) % BigInt(10000) + BigInt(1); // Ensure > 0
      const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes?.[_safeId];
      const owner = currentSnapshot.contractSnapshot.stableBaseCDP.owners?.[_safeId];

      if ((safe === undefined || safe.collateralAmount === BigInt(0)) && (owner === undefined || owner === ethers.ZeroAddress)) {
        break;
      }

      attempts++;
      if (attempts > maxAttempts) {
        throw new Error("Could not generate a unique _safeId after multiple attempts.");
      }
    } while (true);

    // Generate _amount (collateral amount)
    const maxEth = context.getAvailableEther(actor);
    if (maxEth <= BigInt(0)) {
      throw new Error("Account has insufficient ETH to perform this action.");
    }
    const _amount = BigInt(context.prng.next()) % maxEth + BigInt(1); // Ensure > 0

    const actionParams = {
      _safeId: _safeId,
      _amount: _amount
    };

    const newIdentifiers = {
      _safeId: _safeId.toString()
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
      _amount
    } = actionParams;

    try {
      const tx = await this.contract
        .connect(actor.account.value as ethers.Signer)
        .openSafe(_safeId, { value: _amount });

      await tx.wait();
    } catch (e) {
      console.error(e);
      throw e;
    }
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
      _amount
    } = actionParams;

    const prevStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;

    // Safe State: Verify the collateral amount, borrowed amount, weight, total borrowed amount and fee paid
    if (newStableBaseCDP.safes[_safeId].collateralAmount !== _amount) {
      console.error(`Validation failed: safes[_safeId].collateralAmount !== _amount`);
      return false;
    }
    if (newStableBaseCDP.safes[_safeId].borrowedAmount !== BigInt(0)) {
      console.error(`Validation failed: safes[_safeId].borrowedAmount !== 0`);
      return false;
    }
    if (newStableBaseCDP.safes[_safeId].weight !== BigInt(0)) {
      console.error(`Validation failed: safes[_safeId].weight !== 0`);
      return false;
    }
    if (newStableBaseCDP.safes[_safeId].totalBorrowedAmount !== BigInt(0)) {
      console.error(`Validation failed: safes[_safeId].totalBorrowedAmount !== 0`);
      return false;
    }
    if (newStableBaseCDP.safes[_safeId].feePaid !== BigInt(0)) {
      console.error(`Validation failed: safes[_safeId].feePaid !== 0`);
      return false;
    }
     // Verify liquidation snapshots.
    if (newStableBaseCDP.liquidationSnapshots[_safeId].debtPerCollateralSnapshot !== prevStableBaseCDP.cumulativeDebtPerUnitCollateral) {
      console.error(`Validation failed: liquidationSnapshots[_safeId].debtPerCollateralSnapshot !== cumulativeDebtPerUnitCollateral`);
      return false;
    }
    if (newStableBaseCDP.liquidationSnapshots[_safeId].collateralPerCollateralSnapshot !== prevStableBaseCDP.cumulativeCollateralPerUnitCollateral) {
      console.error(`Validation failed: liquidationSnapshots[_safeId].collateralPerCollateralSnapshot !== cumulativeCollateralPerUnitCollateral`);
      return false;
    }

    // NFT Ownership: Verify the owner of the safe.
    if (newStableBaseCDP.owners[_safeId] !== actor.account.address) {
      console.error(`Validation failed: _ownerOf(_safeId) !== msg.sender`);
      return false;
    }

    // Global State: Verify the total collateral has increased by the amount.
    if (newStableBaseCDP.totalCollateral !== prevStableBaseCDP.totalCollateral + _amount) {
      console.error(`Validation failed: totalCollateral has not increased by _amount`);
      return false;
    }

    // TODO: Verify that a OpenSafe event is emitted with the correct parameters
    // For the purpose of this example, we'll assume the event is emitted correctly if all other validations pass.

    return true;
  }
}
