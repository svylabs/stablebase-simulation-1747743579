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
        // Pre-execution validation rule: "The transaction must be sent from the address that currently owns the 'MockPriceOracle' contract."
        const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
        const contractOwner = mockPriceOracleSnapshot.contractOwner;

        if (actor.account.address.toLowerCase() !== contractOwner.toLowerCase()) {
            context.logger.info(`SetPriceAction: Actor ${actor.account.address} is not the owner of MockPriceOracle (${contractOwner}). Skipping action.`);
            return [false, {}, {}];
        }

        // Parameter generation: "_price' parameter must be a non-negative integer"
        // Generate a random price between 1 and 1000 (inclusive) for the base price before 1e18 scaling.
        const _price = (context.prng.next() % 1000n) + 1n;
        
        context.logger.info(`SetPriceAction: Initializing with _price: ${_price}`);

        const actionParams = { _price };
        const newIdentifiers = {}; // No new identifiers created for this action
        
        return [true, actionParams, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        context.logger.info(`SetPriceAction: Executing setPrice with _price: ${actionParams._price}`);
        const signer = actor.account.value as ethers.Signer;
        const connectedContract = this.contract.connect(signer);
        
        // Call the setPrice function
        const tx = await connectedContract.setPrice(actionParams._price);
        const receipt = await tx.wait();

        if (!receipt) {
            throw new Error("Transaction receipt is null");
        }

        return {
            status: receipt.status === 1 ? 1 : 0, // 1 for success, 0 for failure
            gasUsed: BigInt(receipt.gasUsed.toString()),
            gasPrice: BigInt(tx.gasPrice ? tx.gasPrice.toString() : '0'), // Handle potential undefined gasPrice
            blockNumber: BigInt(receipt.blockNumber),
            transactionHash: receipt.transactionHash,
            events: receipt.logs.map(log => ({
                address: log.address,
                topics: log.topics,
                data: log.data,
                logIndex: log.logIndex,
                blockHash: log.blockHash,
                transactionHash: log.transactionHash,
                transactionIndex: log.transactionIndex,
                blockNumber: log.blockNumber
            }))
        };
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        context.logger.info(`SetPriceAction: Validating execution for _price: ${actionParams._price}`);

        // Validate transaction status
        expect(executionReceipt.status).to.equal(1, "Transaction should be successful");

        // Contract State Validation:
        // "Verify that the 'price' state variable in the 'MockPriceOracle' contract,
        // when queried via the 'price()' view function, returns a value equal to the '_price'
        // parameter provided during the transaction, multiplied by 1e18."
        const expectedPrice = actionParams._price * 10n**18n;
        expect(newSnapshot.contractSnapshot.mockPriceOracle.currentPrice).to.equal(
            expectedPrice,
            `MockPriceOracle price should be updated to ${expectedPrice}`
        );

        // Account Balance Validation:
        // Check ETH balance of the actor
        const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address];
        const gasCost = executionReceipt.gasUsed * executionReceipt.gasPrice;
        const expectedEthBalance = previousEthBalance - gasCost;

        expect(newSnapshot.accountSnapshot[actor.account.address]).to.equal(
            expectedEthBalance,
            "Actor's ETH balance should reflect gas cost"
        );

        // No token balance changes or new identifiers to validate for this action.
        // No specific events are mentioned for this function in the snippet, so no event validation is performed.
        
        context.logger.info(`SetPriceAction: Validation successful for _price: ${actionParams._price}`);
        return true;
    }
}
