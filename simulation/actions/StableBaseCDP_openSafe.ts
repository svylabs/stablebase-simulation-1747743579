import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { BigNumber, ethers } from 'ethers';

export class OpensafeAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super();
    this.contract = contract;
  }

  /**
   * Initializes the OpenSafe action by generating the necessary parameters.
   * @param context The RunContext object.
   * @param actor The Actor object.
   * @param currentSnapshot The current Snapshot object.
   * @returns A tuple containing the action parameters and a record of new identifiers.
   */
  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Generate _safeId that does not already exist
    let _safeId: BigNumber;
    let safeExists = true;
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loops

    const existingSafeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes).map(Number);
    const addressSafeCount = Object.values(currentSnapshot.contractSnapshot.stableBaseCDP.owners).filter(owner => owner === actor.account.address).length; // approximate to allow for pending updates

    if (addressSafeCount >= 100) {
      throw new Error("Actor has reached the maximum number of safes allowed.");
    }

    do {
      if (attempts > maxAttempts) {
        throw new Error("Could not generate a unique _safeId after multiple attempts.");
      }

      _safeId = BigNumber.from(context.prng.next()).mod(10000).add(1); // Ensure it's greater than 0

      safeExists = existingSafeIds.includes(_safeId.toNumber());

      attempts++;
    } while (safeExists);

    // Generate _amount greater than 0, but within the actor's ETH balance and total collateral.
    const actorEth = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const totalCollateral = currentSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0);

    let maxCollateral = actorEth;

    // Ensure maxCollateral is not too high
    if (maxCollateral > BigNumber.from(100)) {
        maxCollateral = BigNumber.from(100)
    }

    const _amount = BigNumber.from(context.prng.next()).mod(maxCollateral).add(1); // Ensure it's greater than 0

    const params = [_safeId, _amount];
    const newIdentifiers = { _safeId: _safeId.toString() };

    return [params, newIdentifiers];
  }

  /**
   * Executes the OpenSafe action.
   * @param context The RunContext object.
   * @param actor The Actor object.
   * @param currentSnapshot The current Snapshot object.
   * @param actionParams The parameters for the action.
   */
  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: [BigNumber, BigNumber]
  ): Promise<Record<string, any> | void> {
    const [_safeId, _amount] = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .openSafe(_safeId, { value: _amount });

    await tx.wait();
  }

  /**
   * Validates the OpenSafe action.
   * @param context The RunContext object.
   * @param actor The Actor object.
   * @param previousSnapshot The previous Snapshot object.
   * @param newSnapshot The new Snapshot object.
   * @param actionParams The parameters for the action.
   * @returns True if the action is valid, false otherwise.
   */
  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: [BigNumber, BigNumber]
  ): Promise<boolean> {
    const [_safeId, _amount] = actionParams;

    // Verify that `safes[_safeId].collateralAmount` is equal to the `_amount` provided.
    if (!BigNumber.from(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.collateralAmount || 0).eq(_amount)) {
      console.error(`safes[_safeId].collateralAmount validation failed. Expected: ${_amount}, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.collateralAmount}`);
      return false;
    }

    // Verify that `safes[_safeId].borrowedAmount` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.borrowedAmount !== BigInt(0)) {
      console.error(`safes[_safeId].borrowedAmount validation failed. Expected: 0, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.borrowedAmount}`);
      return false;
    }

    // Verify that `safes[_safeId].weight` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.weight !== BigInt(0)) {
      console.error(`safes[_safeId].weight validation failed. Expected: 0, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.weight}`);
      return false;
    }

    // Verify that `safes[_safeId].totalBorrowedAmount` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.totalBorrowedAmount !== BigInt(0)) {
      console.error(`safes[_safeId].totalBorrowedAmount validation failed. Expected: 0, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.totalBorrowedAmount}`);
      return false;
    }

    // Verify that `safes[_safeId].feePaid` is 0.
    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.feePaid !== BigInt(0)) {
      console.error(`safes[_safeId].feePaid validation failed. Expected: 0, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId.toString()]?.feePaid}`);
      return false;
    }

    // Verify that `liquidationSnapshots[_safeId].debtPerCollateralSnapshot` is equal to `cumulativeDebtPerUnitCollateral`.
    if (newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId.toString()]?.debtPerCollateralSnapshot !== newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral) {
      console.error(`liquidationSnapshots[_safeId].debtPerCollateralSnapshot validation failed. Expected: ${newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral}, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId.toString()]?.debtPerCollateralSnapshot}`);
      return false;
    }

    // Verify that `liquidationSnapshots[_safeId].collateralPerCollateralSnapshot` is equal to `cumulativeCollateralPerUnitCollateral`.
    if (newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId.toString()]?.collateralPerCollateralSnapshot !== newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral) {
      console.error(`liquidationSnapshots[_safeId].collateralPerCollateralSnapshot validation failed. Expected: ${newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral}, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId.toString()]?.collateralPerCollateralSnapshot}`);
      return false;
    }

    // Verify that `_ownerOf(_safeId)` returns `msg.sender`.
    if (newSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId.toString()] !== actor.account.address) {
      console.error(`_ownerOf(_safeId) validation failed. Expected: ${actor.account.address}, Actual: ${newSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId.toString()]}`);
      return false;
    }

    // Verify that `totalCollateral` has increased by `_amount`.
    if (BigNumber.from(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral).sub(BigNumber.from(previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral)).eq(_amount) === false) {
      console.error(`totalCollateral validation failed. Expected increase: ${_amount}, Actual increase: ${BigNumber.from(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral).sub(BigNumber.from(previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral))}`);
      return false;
    }

    return true;
  }
}
