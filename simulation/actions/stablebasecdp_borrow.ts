import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

class BorrowAction extends Action {
  private contract: ethers.Contract;
  private BASIS_POINTS_DIVISOR: BigInt;

  constructor(contract: ethers.Contract) {
    super('BorrowAction');
    this.contract = contract;
    this.BASIS_POINTS_DIVISOR = BigInt(10000);
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const safeId = actor.identifiers.safeId;
    if (!safeId) {
      throw new Error('SafeId is required');
    }

    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    if (!stableBaseCDPSnapshot) {
      throw new Error('StableBaseCDP snapshot not found');
    }

    const safe = stableBaseCDPSnapshot.safes[safeId];
    if (!safe) {
      throw new Error(`Safe with id ${safeId} not found`);
    }

    const currentBorrowedAmount = safe.borrowedAmount;

    // Generate random amount to borrow, ensuring it meets the minimum debt requirement
    const minBorrowAmount = BigInt(1);
    // Example maximum value, should be based on collateral and liquidation ratio
    const maxBorrowAmount = BigInt(1000000000000000000);

    let amount = BigInt(Math.floor(context.prng.next() % Number(maxBorrowAmount)));
    if (amount === BigInt(0)) {
      amount = minBorrowAmount;
    }

    const shieldingRate = BigInt(Math.floor(context.prng.next() % 10000)); // Basis points, 0-10000 (0%-100%)
    const nearestSpotInLiquidationQueue = BigInt(0); // Can be 0 if unknown
    const nearestSpotInRedemptionQueue = BigInt(0); // Can be 0 if unknown

    const _shieldingFee = (amount * shieldingRate) / this.BASIS_POINTS_DIVISOR;

    const parameters = [
      safeId,
      amount,
      shieldingRate,
      nearestSpotInLiquidationQueue,
      nearestSpotInRedemptionQueue,
    ];

    return [parameters, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const safeId = actionParams[0];
    const amount = actionParams[1];
    const shieldingRate = actionParams[2];
    const nearestSpotInLiquidationQueue = actionParams[3];
    const nearestSpotInRedemptionQueue = actionParams[4];

    const tx = await this.contract
      .connect(actor.account.value as unknown as ethers.Signer)
      .borrow(
        safeId,
        amount,
        shieldingRate,
        nearestSpotInLiquidationQueue,
        nearestSpotInRedemptionQueue
      );

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
    const amount = actionParams[1];
    const shieldingRate = actionParams[2];

    const previousStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;

    if (!previousStableBaseCDP || !newStableBaseCDP) {
      throw new Error('StableBaseCDP snapshot not found');
    }

    // Validate Safe State
    const previousSafe = previousStableBaseCDP.safes[safeId];
    const newSafe = newStableBaseCDP.safes[safeId];

    if (!previousSafe || !newSafe) {
      throw new Error(`Safe with id ${safeId} not found`);
    }

    const _shieldingFee = (amount * shieldingRate) / this.BASIS_POINTS_DIVISOR;
    const expectedBorrowedAmount = previousSafe.borrowedAmount + amount;
    expect(newSafe.borrowedAmount).to.equal(expectedBorrowedAmount, 'borrowedAmount should increase by the correct amount');

    const expectedTotalBorrowedAmount = previousSafe.totalBorrowedAmount + amount;
    expect(newSafe.totalBorrowedAmount).to.equal(expectedTotalBorrowedAmount, 'totalBorrowedAmount should increase by the correct amount');

    const expectedFeePaid = previousSafe.feePaid + _shieldingFee;
    expect(newSafe.feePaid).to.equal(expectedFeePaid, 'feePaid should increase by the correct shielding fee amount');

    // Validate Debt and Protocol Mode
    const expectedTotalDebt = previousStableBaseCDP.totalDebt + amount;
    expect(newStableBaseCDP.totalDebt).to.equal(expectedTotalDebt, 'totalDebt should increase by the borrowed amount');

     // Validate account balances
    const actorAddress = actor.account.address;
    const previousAccountBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    //Assuming SBD is the token
    const sbdTokenAddress = "0x..."; // Replace with the actual SBD token address. You may need to fetch it from the contract.
    const previousSBDAccountBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balances[actorAddress] || BigInt(0);
    const newSBDAccountBalance = newSnapshot.contractSnapshot.stableBaseCDP.balances[actorAddress] || BigInt(0);
    const expectedSBDAccountBalance = previousSBDAccountBalance + (amount - _shieldingFee);

    expect(newSBDAccountBalance).to.equal(expectedSBDAccountBalance, 'Account SBD balance should increase by amount - shieldingFee');

    // Validate contract balances
    const contractAddress = this.contract.target;
    const previousContractBalance = previousSnapshot.accountSnapshot[contractAddress] || BigInt(0);
    const newContractBalance = newSnapshot.accountSnapshot[contractAddress] || BigInt(0);

     const previousSBDContractBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balances[contractAddress] || BigInt(0);
     const newSBDContractBalance = newSnapshot.contractSnapshot.stableBaseCDP.balances[contractAddress] || BigInt(0);

    const expectedSBDContractBalance = previousSBDContractBalance + _shieldingFee;
    expect(newSBDContractBalance).to.equal(expectedSBDContractBalance, 'Contract SBD balance should increase by shieldingFee');

    // Validate PROTOCOL_MODE
    if (previousStableBaseCDP.mode === 0 && newStableBaseCDP.totalDebt > BigInt(0)) {
        expect(newStableBaseCDP.mode).to.equal(1, 'PROTOCOL_MODE should transition from BOOTSTRAP to NORMAL if the debt exceeds the threshold.');
    }

      // Validate doubly linked lists
      // Need logic to validate updates in safesOrderedForLiquidation and safesOrderedForRedemption

    return true;
  }
}

export default BorrowAction;
