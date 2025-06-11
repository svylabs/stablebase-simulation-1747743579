import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {ethers} from "ethers";
import {expect} from 'chai';

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
        const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot?.mockPriceOracle;
        if (!mockPriceOracleSnapshot) {
            console.log("MockPriceOracle snapshot is not available, cannot proceed.");
            return [false, {}, {}];
        }

        if (actor.account.address !== mockPriceOracleSnapshot.ownerAddress) {
            console.log("Actor is not the owner of the contract, cannot proceed.");
            return [false, {}, {}];
        }

        // Use a random price between 0 and lastGoodPrice
        const maxPrice = mockPriceOracleSnapshot.lastGoodPrice > 10000n ? 10000n : mockPriceOracleSnapshot.lastGoodPrice;
        const price = BigInt(Math.floor(context.prng.next() % Number(maxPrice)));

        const actionParams = {
            _price: price,
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot?.mockPriceOracle;
        if (!mockPriceOracleSnapshot) {
            console.log("MockPriceOracle snapshot is not available, cannot proceed.");
            return {receipt: null as any, additionalInfo: {}};
        }

        const tx = await this.contract.connect(actor.account.value).setPrice(actionParams._price);
        return {receipt: await tx.wait(), additionalInfo: {}};
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const previousMockPriceOracleSnapshot = previousSnapshot.contractSnapshot?.mockPriceOracle;
        const newMockPriceOracleSnapshot = newSnapshot.contractSnapshot?.mockPriceOracle;

        if (!previousMockPriceOracleSnapshot || !newMockPriceOracleSnapshot) {
            console.log("MockPriceOracle snapshot is not available for validation.");
            return false;
        }

        const expectedPrice = actionParams._price * (10n ** 18n);

        expect(newMockPriceOracleSnapshot.currentPrice).to.equal(expectedPrice,
            "Price should be updated to the new price.");

        // Validate Account balances.
        const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        expect(newAccountBalance).to.lte(previousAccountBalance, "Account balance should not increase.");

        return true;
    }
}
