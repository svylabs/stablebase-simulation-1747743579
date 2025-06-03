import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';

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
    let _amount: bigint;

    // Generate a unique _safeId
    do {
      _safeId = BigInt(Math.floor(context.prng.next() % 10000) + 1); // Ensure it's greater than 0
    } while (
      currentSnapshot.contractSnapshot.stableBaseCDP.safes &&
      currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId] &&
      currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].collateralAmount !== BigInt(0)
    );

    // Generate an _amount greater than 0.  Cap it at some reasonable value
    _amount = BigInt(Math.floor(context.prng.next() % 100) + 1); // up to 100 wei

    const newIdentifiers: Record<string, any> = {
      _safeId: _safeId.toString(),
    };

    return [{"_safeId": _safeId, "_amount": _amount}, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const {_safeId, _amount} = actionParams

    try {
      const tx = await this.contract
        .connect(actor.account.value as ethers.Signer)
        .openSafe(_safeId, _amount, { value: _amount });
      await tx.wait();
      return { txHash: tx.hash };
    } catch (error: any) {
      console.error('Execution error:', error);
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
    const {_safeId, _amount} = actionParams

    if (!newSnapshot.contractSnapshot.stableBaseCDP.safes || !previousSnapshot.contractSnapshot.stableBaseCDP.safes){
      console.log("safe is undefined in snapshots")
      return false
    }

    // Verify that the safeId exists in the new snapshot, but not in the previous.
    if (previousSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId]) {
        console.log("safe existed in previous snapshot")
        return false;
    }

    // Verify that `safes[_safeId].collateralAmount` is equal to the `_amount` provided.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].collateralAmount !== _amount) {
      console.log("collateral amount is not equal to amount provided")
      return false;
    }

    // Verify that `safes[_safeId].borrowedAmount` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].borrowedAmount !== BigInt(0)) {
      console.log("borrowed amount is not zero")
      return false;
    }

    // Verify that `safes[_safeId].weight` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].weight !== BigInt(0)) {
      console.log("weight is not zero")
      return false;
    }

    // Verify that `safes[_safeId].totalBorrowedAmount` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].totalBorrowedAmount !== BigInt(0)) {
        console.log("total borrowed amount is not zero")
        return false;
    }

    // Verify that `safes[_safeId].feePaid` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId].feePaid !== BigInt(0)) {
        console.log("fee paid is not zero")
        return false;
    }
    
    //Verify that totalCollateral has increased by `_amount`
    if (newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral - previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral !== _amount){
      console.log("Total Collateral did not increase by amount")
      return false
    }

    return true;
  }
}
