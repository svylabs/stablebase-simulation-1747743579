import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Account, Action } from "@svylabs/ilumia";
import { expect } from 'chai';


export class BorrowAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("BorrowAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(safeId => BigInt(safeId));
    if (safeIds.length === 0) {
      throw new Error("No safes available to borrow from");
    }

    const safeId = safeIds[context.prng.next() % BigInt(safeIds.length)];
    const safe = stableBaseCDPSnapshot.safes[safeId];

    // Fetch price from MockPriceOracle
    const price = BigInt(1000000000); // Mock price
    const liquidationRatio = BigInt(1500000000000000000); // Assuming 1.5, needs to come from contract
    const MINIMUM_DEBT = BigInt(1000000000000000000); // Assuming 1, needs to come from contract

    // Calculate maxBorrowAmount
    const maxBorrowAmount = (safe.collateralAmount * price * BigInt(100)) / liquidationRatio;

    let amount;
    if (maxBorrowAmount > MINIMUM_DEBT) {
        amount = BigInt(context.prng.next()) % (maxBorrowAmount - MINIMUM_DEBT) + MINIMUM_DEBT; // Amount > 0
    } else {
        amount = MINIMUM_DEBT;
    }


    const shieldingRate = BigInt(context.prng.next()) % BigInt(10000); // Up to 100%
    const nearestSpotInLiquidationQueue = BigInt(0); // Assuming 0 if not known
    const nearestSpotInRedemptionQueue = BigInt(0); // Assuming 0 if not known

    const params = [
      safeId,
      amount,
      shieldingRate,
      nearestSpotInLiquidationQueue,
      nearestSpotInRedemptionQueue,
    ];

    return [params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue] = actionParams;

    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
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
    const [safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue] = actionParams;

    const prevStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const prevSafe = prevStableBaseCDPSnapshot.safes[safeId];
    const newSafe = newStableBaseCDPSnapshot.safes[safeId];
    const prevTotalDebt = prevStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;
    const contractAddress = this.contract.target;

    const prevAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] ?? BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] ?? BigInt(0);
    const prevContractBalance = previousSnapshot.accountSnapshot[contractAddress] ?? BigInt(0);
    const newContractBalance = newSnapshot.accountSnapshot[contractAddress] ?? BigInt(0);

    const BASIS_POINTS_DIVISOR = BigInt(10000);
    const shieldingFee = (amount * shieldingRate) / BASIS_POINTS_DIVISOR;
    const amountToBorrow = amount - shieldingFee;

    // Safe State
    expect(newSafe.borrowedAmount).to.equal(prevSafe.borrowedAmount + amount, "borrowedAmount should increase by amount");
    expect(newSafe.totalBorrowedAmount).to.equal(prevSafe.totalBorrowedAmount + amount, "totalBorrowedAmount should increase by amount");
    expect(newSafe.feePaid).to.equal(prevSafe.feePaid + shieldingFee, "feePaid should increase by shieldingFee");

    // Total Debt
    expect(newTotalDebt).to.equal(prevTotalDebt + amount, "Total debt should increase by the borrowed amount");

    // Account Balance
    expect(newAccountBalance).to.equal(prevAccountBalance + amountToBorrow, 'User balance should increase by amountToBorrow');

    // Contract Balance
     if (shieldingFee > BigInt(0)) {
         expect(newContractBalance).to.equal(prevContractBalance + shieldingFee, "Contract balance should increase by shieldingFee");
     }

   //PROTOCOL_MODE
    if (prevStableBaseCDPSnapshot.mode === 0 && newStableBaseCDPSnapshot.mode === 1) {
        // Assuming 0 is BOOTSTRAP and 1 is NORMAL
        expect(newTotalDebt).to.be.greaterThan(BigInt(1000000000)); // Replace 1000000000 with actual BOOTSTRAP_MODE_DEBT_THRESHOLD
    }


     // Validate liquidation and redemption queue changes
     // Assuming the queues are updated based on the borrow
     // More detailed validation might be required based on the specific queue logic

    return true;
  }
}
