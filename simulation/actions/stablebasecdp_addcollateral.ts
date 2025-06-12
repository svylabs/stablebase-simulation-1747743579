import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { expect } from 'chai';
import { ethers } from "ethers";

// Constants from the context
const PRECISION = 10n ** 18n;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * (10n ** 18n);

export class AddcollateralAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("AddcollateralAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const actorAddress = actor.account.address;
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const actorEthBalance = currentSnapshot.accountSnapshot[actorAddress] || 0n;

        let safeId: bigint | undefined;
        let foundOwnedSafe = false;

        // Iterate through safeOwner to find a safe owned by the actor
        for (const sId in stableBaseCDPSnapshot.safeOwner) {
            const owner = stableBaseCDPSnapshot.safeOwner[sId];
            const currentSafeId = BigInt(sId);
            if (owner.toLowerCase() === actorAddress.toLowerCase()) {
                // Check if collateralAmount > 0 as per validation rule
                if (stableBaseCDPSnapshot.safeDetails[currentSafeId] && stableBaseCDPSnapshot.safeDetails[currentSafeId].collateralAmount > 0n) {
                    safeId = currentSafeId;
                    foundOwnedSafe = true;
                    break;
                }
            }
        }

        if (!foundOwnedSafe) {
            // console.log(`[Initialize] No valid CDP (safeId with collateral > 0) found for actor ${actorAddress}.`);
            return [false, {}, {}];
        }

        // Determine amount: a positive uint256 value. Must be less than actor's ETH balance.
        // Let's generate an amount between 0.1 ETH and 5 ETH (in wei)
        const minAmountEth = 1n * PRECISION / 10n; // 0.1 ETH
        const maxAmountEth = 5n * PRECISION;      // 5 ETH

        // Use context.prng to generate a random amount within a reasonable range
        // prng.next() gives [0, 2^32-1]
        const randomFactor = BigInt(context.prng.next());
        const amountRange = maxAmountEth - minAmountEth;
        const amount = minAmountEth + (randomFactor % amountRange);

        if (actorEthBalance < amount + (2n * PRECISION / 100n)) { // 0.02 ETH buffer for gas
            // console.log(`[Initialize] Actor ${actorAddress} has insufficient ETH balance (${actorEthBalance}) to add ${amount} collateral.`);
            return [false, {}, {}];
        }

        // nearestSpotInLiquidationQueue can be 0 for simplicity.
        // For more advanced scenarios, we could randomly pick an existing safeId from safesOrderedForLiquidation.nodes
        const nearestSpotInLiquidationQueue = 0n;

        const actionParams = {
            safeId: safeId!,
            amount: amount,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value;
        const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;

        // Ensure the contract is connected to the signer for the transaction
        const contractWithSigner = this.contract.connect(signer);

        // Call addCollateral with the amount as msg.value
        const tx = await contractWithSigner.addCollateral(
            safeId,
            amount,
            nearestSpotInLiquidationQueue,
            { value: amount } // Send the amount as msg.value
        );
        const receipt = await tx.wait();

        if (!receipt) {
            throw new Error("Transaction failed or receipt is null.");
        }

        // The ExecutionReceipt type requires: txHash, gasUsed, logs, events
        // Ethers v6 receipt has gasUsed as bigint, logs as array of Log, events (if parsed)
        // context.logger.info(`[Execute] addCollateral transaction successful for safeId: ${safeId}, amount: ${amount}`);
        return {
            txHash: receipt.hash,
            gasUsed: receipt.gasUsed,
            logs: receipt.logs,
            events: receipt.logs.map(log => contractWithSigner.interface.parseLog(log)).filter(Boolean) // Parse logs to events
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
        const actorAddress = actor.account.address;
        const { safeId, amount } = actionParams;

        const prevStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
        const prevSafesOrderedForLiquidationSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const newSafesOrderedForLiquidationSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

        const gasUsed = executionReceipt.gasUsed;

        // --- 0. Initial Balances for ETH ---
        const prevActorEthBalance = previousSnapshot.accountSnapshot[actorAddress] || 0n;
        const newActorEthBalance = newSnapshot.accountSnapshot[actorAddress] || 0n;

        // --- 1. Identify collateralIncrease and debtIncrease from SafeUpdated event (if emitted) ---
        let collateralIncrease = 0n;
        let debtIncrease = 0n;
        let safeUpdatedEventEmitted = false;
        let emittedNewRatio: bigint | undefined;
        let emittedTotalCollateral: bigint | undefined;
        let emittedTotalDebt: bigint | undefined;

        for (const event of executionReceipt.events || []) {
            if (event.name === "SafeUpdated") {
                safeUpdatedEventEmitted = true;
                // These are the *final* values, not the increase. The event provides collateralIncrease and debtIncrease.
                collateralIncrease = event.args.collateralIncrease;
                debtIncrease = event.args.debtIncrease;

                // Validate parameters of SafeUpdated event if it was emitted
                expect(event.args.safeId).to.equal(safeId, "SafeUpdated: safeId mismatch");
                expect(event.args.collateralAmount).to.equal(newStableBaseCDPSnapshot.safeDetails[safeId].collateralAmount, "SafeUpdated: collateralAmount mismatch");
                expect(event.args.borrowedAmount).to.equal(newStableBaseCDPSnapshot.safeDetails[safeId].borrowedAmount, "SafeUpdated: borrowedAmount mismatch");
                expect(event.args.totalCollateral).to.equal(newStableBaseCDPSnapshot.totalCollateral, "SafeUpdated: totalCollateral mismatch");
                expect(event.args.totalDebt).to.equal(newStableBaseCDPSnapshot.totalDebt, "SafeUpdated: totalDebt mismatch");
            } else if (event.name === "AddedCollateral") {
                emittedNewRatio = event.args.newRatio;
                emittedTotalCollateral = event.args.totalCollateral;
                emittedTotalDebt = event.args.totalDebt;

                // Validate parameters of AddedCollateral event
                expect(event.args.safeId).to.equal(safeId, "AddedCollateral: safeId mismatch");
                expect(event.args.amount).to.equal(amount, "AddedCollateral: amount mismatch");
            } else if (event.name === "LiquidationQueueUpdated") {
                // Validate parameters of LiquidationQueueUpdated event
                expect(event.args.safeId).to.equal(safeId, "LiquidationQueueUpdated: safeId mismatch");
                expect(event.args.newRatio).to.equal(emittedNewRatio, "LiquidationQueueUpdated: newRatio mismatch with AddedCollateral");
                // nextNode validation is tricky without detailed list structure, focus on safeId and newRatio
            }
        }

        // --- 2. CDP State Validation ---
        const prevSafeDetails = prevStableBaseCDPSnapshot.safeDetails[safeId];
        const newSafeDetails = newStableBaseCDPSnapshot.safeDetails[safeId];

        // collateralAmount
        const expectedCollateralAmount = prevSafeDetails.collateralAmount + amount + collateralIncrease;
        expect(newSafeDetails.collateralAmount).to.equal(expectedCollateralAmount, "safes[safeId].collateralAmount mismatch");

        // borrowedAmount
        const expectedBorrowedAmount = prevSafeDetails.borrowedAmount + debtIncrease;
        expect(newSafeDetails.borrowedAmount).to.equal(expectedBorrowedAmount, "safes[safeId].borrowedAmount mismatch");

        // totalBorrowedAmount
        const expectedTotalBorrowedAmount = prevSafeDetails.totalBorrowedAmount + debtIncrease;
        expect(newSafeDetails.totalBorrowedAmount).to.equal(expectedTotalBorrowedAmount, "safes[safeId].totalBorrowedAmount mismatch");

        // new collateralization ratio
        const calculatedNewRatio = (newSafeDetails.borrowedAmount * PRECISION) / newSafeDetails.collateralAmount;
        expect(calculatedNewRatio).to.equal(emittedNewRatio, "Calculated newRatio mismatch with emitted event newRatio");

        // --- 3. Global Contract State Validation ---
        // totalCollateral
        const expectedTotalCollateral = prevStableBaseCDPSnapshot.totalCollateral + amount + collateralIncrease;
        expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(expectedTotalCollateral, "totalCollateral mismatch");
        expect(emittedTotalCollateral).to.equal(newStableBaseCDPSnapshot.totalCollateral, "Emitted totalCollateral mismatch");

        // totalDebt
        const expectedTotalDebt = prevStableBaseCDPSnapshot.totalDebt + debtIncrease;
        expect(newStableBaseCDPSnapshot.totalDebt).to.equal(expectedTotalDebt, "totalDebt mismatch");
        expect(emittedTotalDebt).to.equal(newStableBaseCDPSnapshot.totalDebt, "Emitted totalDebt mismatch");


        // PROTOCOL_MODE
        const prevProtocolMode = prevStableBaseCDPSnapshot.protocolMode;
        const newProtocolMode = newStableBaseCDPSnapshot.protocolMode;

        if (prevProtocolMode === 0 /* BOOTSTRAP */ && expectedTotalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD) {
            expect(newProtocolMode).to.equal(1 /* NORMAL */, "PROTOCOL_MODE should transition to NORMAL");
        } else {
            expect(newProtocolMode).to.equal(prevProtocolMode, "PROTOCOL_MODE should remain unchanged");
        }

        // --- 4. Liquidation Snapshots Validation (if SafeUpdated event was emitted) ---
        // Direct validation of `liquidationSnapshots[safeId].collateralPerCollateralSnapshot` and `debtPerCollateralSnapshot`
        // is not possible from the provided `StableBaseCDPSnapshot` interface. 
        // The `SafeUpdated` event parameters serve as indirect validation that the update happened correctly.
        // Validation of event parameters (collateralAmount, borrowedAmount, collateralIncrease, debtIncrease, etc.)
        // already covers the outcome of _updateSafe.


        // --- 5. Liquidation Queue Validation (using safesOrderedForLiquidation) ---
        const newLiquidationNode = newSafesOrderedForLiquidationSnapshot.nodes[safeId.toString()];
        expect(newLiquidationNode.value).to.equal(calculatedNewRatio, "safesOrderedForLiquidation.nodes[safeId].value mismatch");

        // Validate positioning in the linked list (simplified checks)
        if (newSafesOrderedForLiquidationSnapshot.headId === safeId) {
            if (newLiquidationNode.next !== 0n) {
                const nextNodeValue = newSafesOrderedForLiquidationSnapshot.nodes[newLiquidationNode.next.toString()].value;
                expect(newLiquidationNode.value).to.be.lte(nextNodeValue, "New head's value is not less than or equal to its next node's value.");
            }
        }
        if (newSafesOrderedForLiquidationSnapshot.tailId === safeId) {
            if (newLiquidationNode.prev !== 0n) {
                const prevNodeValue = newSafesOrderedForLiquidationSnapshot.nodes[newLiquidationNode.prev.toString()].value;
                expect(newLiquidationNode.value).to.be.gte(prevNodeValue, "New tail's value is not greater than or equal to its previous node's value.");
            }
        }
        // General positioning validation for prev/next pointers
        if (newLiquidationNode.prev !== 0n) {
            const prevNode = newSafesOrderedForLiquidationSnapshot.nodes[newLiquidationNode.prev.toString()];
            expect(prevNode.next).to.equal(safeId, "Linked list integrity: prev node's next pointer mismatch");
            expect(prevNode.value).to.be.lte(newLiquidationNode.value, "Linked list order: prev node's value is greater than current node's value");
        }
        if (newLiquidationNode.next !== 0n) {
            const nextNode = newSafesOrderedForLiquidationSnapshot.nodes[newLiquidationNode.next.toString()];
            expect(nextNode.prev).to.equal(safeId, "Linked list integrity: next node's prev pointer mismatch");
            expect(nextNode.value).to.be.gte(newLiquidationNode.value, "Linked list order: next node's value is less than current node's value");
        }


        // --- 6. Account ETH Balance Validation ---
        // Actor's ETH balance should decrease by `amount` (msg.value) + `gasUsed`
        const expectedActorEthBalance = prevActorEthBalance - amount - gasUsed;
        expect(newActorEthBalance).to.equal(expectedActorEthBalance, "Actor ETH balance mismatch after transaction");

        return true;
    }
}
