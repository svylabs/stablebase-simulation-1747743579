import { ethers } from 'ethers';
import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { expect } from 'chai';

export class BorrowAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('BorrowAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeIds = Object.keys(stableBaseCDPSnapshot.owners).map(Number);

    if (safeIds.length === 0) {
      throw new Error("No safes available for borrowing.");
    }

    let safeId: number = 0;
    let owner: string | undefined;
    for (let i = 0; i < 10; ++i) {
      safeId = safeIds[context.prng.next() % safeIds.length];
      owner = stableBaseCDPSnapshot.owners[safeId];
      if (owner && ethers.getAddress(owner) === ethers.getAddress(actor.account.address)) {
        break;
      }
    }
    if (!owner || ethers.getAddress(owner) !== ethers.getAddress(actor.account.address)) {
      throw new Error("No safe owned by actor found or invalid safeId");
    }

    const amount = BigInt(context.prng.next() % 10000 + 1000); // Random amount greater than 0
    const shieldingRate = BigInt(context.prng.next() % 10001); // Random shielding rate between 0 and 10000
    const nearestSpotInLiquidationQueue = BigInt(0); // Can be 0
    const nearestSpotInRedemptionQueue = BigInt(0); // Can be 0

    const actionParams = [
      BigInt(safeId),
      amount,
      shieldingRate,
      nearestSpotInLiquidationQueue,
      nearestSpotInRedemptionQueue,
    ];

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const signer = actor.account.value as ethers.Signer;
    try {
      const tx = await this.contract.connect(signer).borrow(...actionParams);
      await tx.wait();
    } catch (error) {
      console.error("Error executing borrow action:", error);
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
    const safeId = actionParams[0];
    const amount = actionParams[1];

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
    const newSafe = newStableBaseCDPSnapshot.safes[safeId];

    const initialBorrowedAmount = previousSafe ? previousSafe.borrowedAmount : BigInt(0);
    const initialTotalBorrowedAmount = previousSafe ? previousSafe.totalBorrowedAmount : BigInt(0);

    expect(newSafe.borrowedAmount).to.equal(initialBorrowedAmount + amount, 'Borrowed amount should increase by amount');
    expect(newSafe.totalBorrowedAmount).to.equal(initialTotalBorrowedAmount + amount, 'Total borrowed amount should increase by amount');
    expect(newStableBaseCDPSnapshot.totalDebt).to.equal(previousStableBaseCDPSnapshot.totalDebt + amount, 'Total debt should increase by amount');

    try {
      const sbdTokenAddress = await this.contract.sbdToken();
      const sbdToken = new ethers.Contract(sbdTokenAddress, ['function balanceOf(address) view returns (uint256)'], this.contract.provider);

      const previousSBDBalance = (previousStableBaseCDPSnapshot.balances && previousStableBaseCDPSnapshot.balances[actor.account.address]) || BigInt(0);
      const newSBDBalance = (newStableBaseCDPSnapshot.balances && newStableBaseCDPSnapshot.balances[actor.account.address]) || BigInt(0);

      const previousSBDBalanceFromContract = await sbdToken.balanceOf(actor.account.address);
      const newSBDBalanceFromContract = await sbdToken.balanceOf(actor.account.address);

      const delta = newSBDBalanceFromContract - previousSBDBalanceFromContract;

      //expect(delta).to.be.gte(BigInt(0), 'SBD token balance should increase');

      expect(newStableBaseCDPSnapshot.owners[safeId]).to.equal(previousStableBaseCDPSnapshot.owners[safeId], 'Owner should remain the same');
    } catch (error) {
      console.error("Error during validation:", error);
      return false;
    }
    return true;
  }
}
