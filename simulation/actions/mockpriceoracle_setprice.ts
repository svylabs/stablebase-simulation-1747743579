import { ethers } from 'ethers';
import { expect } from 'chai';
import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';

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
    ): Promise<[any, Record<string, any>]> {
        // Generate a random uint256 value between 1 and 1000
        const _price = BigInt(Math.floor((context.prng.next() % 1000) + 1));

        return [[_price], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const [_price] = actionParams;
        try {
            const tx = await this.contract.connect(actor.account.value as ethers.Signer).setPrice(_price);
            await tx.wait();
        } catch (error: any) {
            console.error("Error executing setPrice:", error);
            throw new Error(`Transaction failed: ${error.message}`);
        }
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const [_price] = actionParams;

        const previousMockPriceOracleSnapshot = previousSnapshot.contractSnapshot.mockPriceOracle;
        const newMockPriceOracleSnapshot = newSnapshot.contractSnapshot.mockPriceOracle;

        // Validate that the price variable in the MockPriceOracle contract is updated to _price * 1e18.
        const expectedPrice = _price * BigInt(10) ** BigInt(18);
        try {
            expect(newMockPriceOracleSnapshot.price).to.equal(expectedPrice, `Price should be updated correctly. Expected: ${expectedPrice}, Actual: ${newMockPriceOracleSnapshot.price}`);
        } catch (error: any) {
            console.error("Price validation failed:", error);
            throw error;
        }

        // Validate account balances (no ETH sent in this action, so balances should remain the same).
        // Account balances should be validated in a higher level, not here since this action doesn't involve ETH transfer.

        // Validate token balances for the contract (no token transfer in this action, so balances should remain the same).
        // MockPriceOracle doesn't hold tokens, but if it did, we would check its balance here.

        return true;
    }
}
