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

        // Check if the actor is the owner. The action summary said only owner can set the price
        const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
        if (
            mockPriceOracleSnapshot.ownerAddress.toLowerCase() !==
            actor.account.address.toLowerCase()
        ) {
            console.log(`Actor ${actor.account.address} is not the owner, skipping action.`);
            return [false, [], {}];
        }

        // Generate a random price between 0 and 9999 * 10^18
        const price = BigInt(Math.floor(context.prng.next() % 10000)) * BigInt(10 ** 18);

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
        const { _price } = actionParams;

        const tx = await this.contract
            .connect(actor.account.value)
            .setPrice(_price);
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

        const newPrice = newSnapshot.contractSnapshot.mockPriceOracle.currentPrice;
        const expectedPrice = _price * BigInt(1);
        const priceScaled = _price * BigInt(10**18)

        expect(newPrice).to.equal(
            priceScaled,
            "Price should be updated correctly"
        );

        // Validate that the transaction sender is the owner in the new snapshot
        const newMockPriceOracleSnapshot = newSnapshot.contractSnapshot.mockPriceOracle;
        expect(newMockPriceOracleSnapshot.ownerAddress.toLowerCase()).to.equal(
            actor.account.address.toLowerCase(),
            "Sender should be owner"
        );

        return true;
    }
}