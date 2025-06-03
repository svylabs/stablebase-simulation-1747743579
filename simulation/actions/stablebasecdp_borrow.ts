import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

// Assuming IMintableToken interface is defined elsewhere or needs to be defined here
interface IMintableToken {
  balanceOf(account: string): Promise<bigint>;
  // other functions if needed
}

export class BorrowAction extends Action {
  private contract: ethers.Contract;
  private sbdToken: IMintableToken;

  constructor(contract: ethers.Contract, sbdToken: IMintableToken) {
    super("BorrowAction");
    this.contract = contract;
    this.sbdToken = sbdToken;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    //const safeId = BigInt(actor.identifiers.getIdentifiers().safeId || Math.floor(context.prng.next() % 100) + 1); // Example, ensure safeId exists
    // TODO: Check if this safeId exists in stables[safeId] and owned by the actor.
    let safeId;
    if (actor.identifiers.getIdentifiers().safeId) {
        safeId = BigInt(actor.identifiers.getIdentifiers().safeId);
    } else {
        // Generate a random safeId within a reasonable range
        safeId = BigInt(Math.floor(context.prng.next() % 100) + 1);
    }


    const amount = BigInt(Math.floor(context.prng.next() % 1000) + 1); // Example amount, ensure it's greater than 0
    const shieldingRate = BigInt(Math.floor(context.prng.next() % 10001)); // 0 to 10000 (0% to 100%)
    const nearestSpotInLiquidationQueue = BigInt(0); // Can be 0 or a valid safeId
    const nearestSpotInRedemptionQueue = BigInt(0); // Can be 0 or a valid safeId

    const actionParams = {
      safeId: safeId,
      amount: amount,
      shieldingRate: shieldingRate,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
      nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
    };

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const signer = actor.account.value as ethers.Signer;
    const tx = await this.contract.connect(signer).borrow(
      actionParams.safeId,
      actionParams.amount,
      actionParams.shieldingRate,
      actionParams.nearestSpotInLiquidationQueue,
      actionParams.nearestSpotInRedemptionQueue
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
    const safeId = actionParams.safeId as bigint;
    const amount = actionParams.amount as bigint;

    const previousStableBaseCDPSnapshot: any = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot: any = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafeState = previousStableBaseCDPSnapshot.safes[safeId];
    const newSafeState = newStableBaseCDPSnapshot.safes[safeId];

    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    //const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    //const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    //const contractAddress = this.contract.target as string;
    //const previousContractBalance = previousStableBaseCDPSnapshot.balances[contractAddress] || BigInt(0);
    //const newContractBalance = newStableBaseCDPSnapshot.balances[contractAddress] || BigInt(0);

    let sbdTokenBalanceBefore: bigint;
    let sbdTokenBalanceAfter: bigint;
    try {
        sbdTokenBalanceBefore = await this.sbdToken.balanceOf(actor.account.address);
        sbdTokenBalanceAfter = await this.sbdToken.balanceOf(actor.account.address);
    } catch (error) {
        console.error("Error fetching SBD token balances:", error);
        return false;
    }

    // Borrow Amount Validations
    try {
        expect(newSafeState.borrowedAmount).to.equal(
          previousSafeState.borrowedAmount + amount,
          "Borrowed amount validation failed"
        );
        expect(newSafeState.totalBorrowedAmount).to.equal(
          previousSafeState.totalBorrowedAmount + amount,
          "Total borrowed amount validation failed"
        );
        expect(newTotalDebt).to.equal(
          previousTotalDebt + amount,
          "Total debt validation failed"
        );

        // Assuming amountToBorrow is equal to amount for simplicity.  This needs to incorporate shielding fees and refunds.
        const amountToBorrow = amount; // Placeholder: Calculate amountToBorrow correctly

        expect(sbdTokenBalanceAfter).to.equal(
            sbdTokenBalanceBefore + amountToBorrow,
            "Borrower's SBD token balance should increase by amountToBorrow"
        );

        // Shielding Rate Validations - Example, adjust based on actual logic
        if (actionParams.shieldingRate > 0) {
          expect(newSafeState.feePaid).to.be.gt(BigInt(0), "Fee paid should be greater than zero");
        } else {
          expect(newSafeState.feePaid).to.equal(BigInt(0), "Fee paid should be equal to zero");
        }

        // Safe Ownership Validation
        const ownerAfter = newStableBaseCDPSnapshot.owners[safeId];
        expect(ownerAfter).to.equal(actor.account.address, "Safe ownership should remain the same");

        return true;
    } catch (error) {
        console.error("Validation failed:", error);
        return false;
    }
  }
}
