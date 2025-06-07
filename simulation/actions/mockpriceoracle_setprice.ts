import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
import { expect } from 'chai';
import { MockPriceOracle, MockPriceOracle__factory } from "./typechain-types";

export class SetPriceAction extends Action {
  private contract: MockPriceOracle;

  constructor(contract: ethers.Contract) {
    super("SetPriceAction");
    this.contract = MockPriceOracle__factory.connect(contract.target, contract.signer) as MockPriceOracle;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Generate a random price between 1 and 1000
    const maxPrice = BigInt(1000);
    const _price = (BigInt(context.prng.next()) % maxPrice) + BigInt(1);

    return [[_price], {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [_price] = actionParams;

    const tx = await this.contract.connect(actor.account.value).setPrice(_price);
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const [_price] = actionParams;

    const previousMockPriceOracleState = previousSnapshot.contractSnapshot.mockPriceOracle;
    const newMockPriceOracleState = newSnapshot.contractSnapshot.mockPriceOracle;

    // Validate price update
    const expectedPrice = _price * BigInt(1e18);
    expect(newMockPriceOracleState.currentPrice).to.equal(expectedPrice, "Price should be updated correctly");

    // Validate price is not zero if _price was non-zero
    if (_price !== BigInt(0)) {
      expect(newMockPriceOracleState.currentPrice).to.not.equal(BigInt(0), "Price should not be zero");
    }

    // Validate owner unchanged
    expect(newMockPriceOracleState.owner).to.equal(previousMockPriceOracleState.owner, "Owner should remain unchanged");

    //Additional Validations

    //No state changes expected for other contracts, so no need to validate other contracts

    return true;
  }
}
