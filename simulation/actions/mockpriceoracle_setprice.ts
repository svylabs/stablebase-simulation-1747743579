import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class SetPriceAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("SetPriceAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    // Get current price from snapshot to determine a reasonable upper bound
    const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
    const currentPrice = mockPriceOracleSnapshot.price;

    // Generate a random price no more than twice the current price
    // Ensure the maxPrice is not zero to avoid division by zero errors.
    const maxPrice = currentPrice > 0 ? (currentPrice * BigInt(2)) / BigInt(10 ** 18) : BigInt(100); // Default max price if currentPrice is 0
    const price = BigInt(Math.floor(context.prng.next() % Number(maxPrice)));

    // Check if the actor is the owner
    if (mockPriceOracleSnapshot.owner.toLowerCase() !== actor.account.address.toLowerCase()) {
      return [false, {}, {}];
    }

    return [true, { _price: price }, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { _price } = actionParams;
    const tx = await this.contract.connect(actor.account.value).setPrice(_price);
    const receipt = await tx.wait();
    return { receipt };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { _price } = actionParams;

    // Validate price update
    const previousMockPriceOracleSnapshot = previousSnapshot.contractSnapshot.mockPriceOracle;
    const newMockPriceOracleSnapshot = newSnapshot.contractSnapshot.mockPriceOracle;

    const expectedNewPrice = _price * BigInt(10 ** 18);
    expect(newMockPriceOracleSnapshot.price).to.equal(expectedNewPrice, "Price should be updated correctly");

    // Validate owner didn't change
    expect(previousMockPriceOracleSnapshot.owner).to.equal(newMockPriceOracleSnapshot.owner, "Owner should not change");

    // Validate account balances (if applicable). This example assumes there are no
    // ETH transfers as part of this action. If there were, you'd compare the previous and new
    // account snapshots for changes in ETH balance.
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    expect(newAccountBalance).to.equal(previousAccountBalance, "Account balance should not change");

    return true;
  }
}
