import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
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
    // Generate a random price
    const _price = BigInt(context.prng.next()) % BigInt(10000);

    // No new identifiers are created in this action.
    const newIdentifiers: Record<string, any> = {};

    return [true, { _price }, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const { _price } = actionParams;

    // Execute the setPrice function
    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .setPrice(_price);

    const receipt = await tx.wait();

    return receipt;
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

    // Validate that the price state variable is updated to `_price * 1e18`
    const expectedNewPrice = _price * BigInt(10) ** BigInt(18);

    // Call the `price()` function and verify that the returned value matches the expected value.
    const newPrice = await this.contract.price();
    expect(newPrice).to.equal(expectedNewPrice, "The price state variable should be updated to _price * 1e18");

    // Validate ETH balance changes (if any)
    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    // Check if account balance decreased due to gas costs
    expect(newAccountBalance).to.be.lte(previousAccountBalance, "Account balance should decrease or remain the same due to gas costs.");

    //Validate Token balance for affected contracts
    //No token transfer involved, hence no token balance validations required

    return true;
  }
}
