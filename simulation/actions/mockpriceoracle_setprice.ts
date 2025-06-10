import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class SetPriceAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("SetPriceAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const mockPriceOracleState = currentSnapshot.contractSnapshot.mockPriceOracle;
    const currentPrice = mockPriceOracleState.price;

    // Generate a random price between 50% and 150% of the current price
    const minPrice = currentPrice / 2n;
    const maxPrice = currentPrice + currentPrice / 2n;

    // Generate a random price within the calculated range
    const priceRange = maxPrice - minPrice + 1n;
    let price = minPrice + BigInt(Math.floor(context.prng.next() % Number(priceRange)));
    if(price <= 0n){
        price = 1n; //Setting a minimum possible price to 1 to avoid errors, and to make sure it is executable
    }

    return [true, [price], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const price = actionParams[0];
    const tx = await this.contract.connect(actor.account.value).setPrice(price);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const price = actionParams[0];

    const previousMockPriceOracleState = previousSnapshot.contractSnapshot.mockPriceOracle;
    const newMockPriceOracleState = newSnapshot.contractSnapshot.mockPriceOracle;

    // Validate that the price was updated correctly.
    expect(newMockPriceOracleState.price).to.equal(
      price,
      "Price was not updated correctly"
    );

    // Validate eth balances
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || 0n;
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || 0n;
    expect(newAccountBalance).to.lte(previousAccountBalance - executionReceipt.gasCost, 'Eth balance should be reduced due to gas fees');

    return true;
  }
}