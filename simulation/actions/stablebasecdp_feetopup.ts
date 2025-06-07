import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";

export class FeeTopupAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("FeeTopupAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const safeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes).map(Number);
    if (safeIds.length === 0) {
      throw new Error("No safes available to top up fee.");
    }

    const safeId = safeIds[context.prng.next() % safeIds.length];
    const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];

    if (!safe) {
      throw new Error(`Safe with ID ${safeId} not found.`);
    }

    // Ensure topupRate is within reasonable bounds based on safe's borrowedAmount
    const maxTopupRate = BigInt(10000);
    const topupRate = BigInt(context.prng.next()) % maxTopupRate + BigInt(1); // Ensure topupRate is non-zero
    const nearestSpotInRedemptionQueue = BigInt(0);

    return [
      [safeId, topupRate, nearestSpotInRedemptionQueue],
      {}
    ];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [safeId, topupRate, nearestSpotInRedemptionQueue] = actionParams;
    return this.contract.connect(actor.account.value).feeTopup(
      safeId,
      topupRate,
      nearestSpotInRedemptionQueue
    );
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const [safeId, topupRate, nearestSpotInRedemptionQueue] = actionParams;

    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;

    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const safePrevious = stableBaseCDPPrevious.safes[safeId];
    const safeNew = stableBaseCDPNew.safes[safeId];

    const sbdTokenAddress = (context.contracts.dfidToken as any).target;
    const contractAddress = (context.contracts.stableBaseCDP as any).target;
    const userAddress = actor.account.address;

    if (!safePrevious || !safeNew) {
      throw new Error(`Safe with ID ${safeId} not found in snapshot.`);
    }

    // Validate that safes[safeId].weight has increased by topupRate.
    expect(safeNew.weight).to.equal(safePrevious.weight + BigInt(topupRate), "Safe weight should increase by topupRate");

    // Calculate expected fee
    const expectedFee = (BigInt(topupRate) * safePrevious.borrowedAmount) / BigInt(10000);

    // Validate that safes[safeId].feePaid has increased by the actual fee deducted.
    expect(safeNew.feePaid).to.be.gte(safePrevious.feePaid, "Safe feePaid should increase");

    // Validate that the user's SBD token balance has decreased by the fee amount, minus any refund.
    const userSBDTokenBalancePrevious = dfidTokenPrevious.balances[userAddress] || BigInt(0);
    const userSBDTokenBalanceNew = dfidTokenNew.balances[userAddress] || BigInt(0);

    const feePaidDiff = safeNew.feePaid - safePrevious.feePaid;
    const refundAmount = userSBDTokenBalancePrevious - userSBDTokenBalanceNew + feePaidDiff;

    expect(userSBDTokenBalanceNew).to.be.lte(userSBDTokenBalancePrevious, "User SBD token balance should decrease.");

    // Validate that the contract's SBD token balance has increased by the fee amount, accounting for refund.
    const contractSBDTokenBalancePrevious = dfidTokenPrevious.balances[contractAddress] || BigInt(0);
    const contractSBDTokenBalanceNew = dfidTokenNew.balances[contractAddress] || BigInt(0);

    expect(contractSBDTokenBalanceNew - contractSBDTokenBalancePrevious).to.be.gte(feePaidDiff - refundAmount, "Contract SBD token balance should increase by at least the fee paid minus refund.");

    // Validate total debt and collateral
    expect(stableBaseCDPNew.totalDebt).to.be.gte(stableBaseCDPPrevious.totalDebt, 'Total debt should increase or remain the same');
    expect(stableBaseCDPNew.totalCollateral).to.be.gte(stableBaseCDPPrevious.totalCollateral, 'Total collateral should increase or remain the same');

        // Verify FeeTopup event is emitted with the correct parameters (safeId, topupRate, feePaid, newWeight).
        const events = newSnapshot.events;
        if (events && events.length > 0) {
            const feeTopupEvent = events.find((e: any) => e.name === 'FeeTopup' && e.address === contractAddress);
            if (feeTopupEvent) {
                expect(feeTopupEvent.args.safeId).to.eq(BigInt(safeId), 'FeeTopup event safeId should match');
                expect(feeTopupEvent.args.topupRate).to.eq(BigInt(topupRate), 'FeeTopup event topupRate should match');
                expect(feeTopupEvent.args.fee).to.eq(feePaidDiff, 'FeeTopup event feePaid should match');
                expect(feeTopupEvent.args.newWeight).to.eq(safeNew.weight, 'FeeTopup event newWeight should match');
            } else {
                throw new Error('FeeTopup event not found');
            }
        } else {
            throw new Error('No events found in the snapshot');
        }

        // Check state changes in OrderedDoublyLinkedList (safesOrderedForRedemption)
        const safesOrderedForRedemptionPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;
        // Basic check: head and tail are updated or not
        if(safesOrderedForRedemptionPrevious.head !== safesOrderedForRedemptionNew.head) {
            console.log("Head is updated in safesOrderedForRedemption.");
        }
        if(safesOrderedForRedemptionPrevious.tail !== safesOrderedForRedemptionNew.tail) {
            console.log("Tail is updated in safesOrderedForRedemption");
        }

    return true;
  }
}
