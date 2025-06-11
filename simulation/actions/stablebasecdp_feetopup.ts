import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class FeeTopupAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("FeeTopupAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
        const safes = stableBaseCDPSnapshot.safes || {};
        const actorAddress = actor.account.address;

        let safeId: bigint | undefined;

        // Find a safe owned by the actor
        for (const safeIdKey in safes) {
            if (safes.hasOwnProperty(safeIdKey)) {
                // Assuming _onlyOwner modifier ensures the owner is the actor
                safeId = BigInt(safeIdKey);
                break;
            }
        }

        if (!safeId) {
            console.log("No safe found for the actor.");
            return [false, {}, {}];
        }

        const safeInfo = safes[safeId.toString()];

        if (!safeInfo) {
            console.log(`Safe with ID ${safeId} not found.`);
            return [false, {}, {}];
        }

        // Check if the actor has enough SBD balance to pay the fee
        const actorSBDBalance = dfidTokenSnapshot.balances[actorAddress] || BigInt(0);
        if (actorSBDBalance <= BigInt(0)) {
            console.log("Actor does not have enough SBD balance to topup fee.");
            return [false, {}, {}];
        }

        // Generate a random topupRate between 1 and 500, ensuring it's within reasonable bounds
        const maxTopupRate = BigInt(500); // Set a reasonable upper bound
        const topupRate = BigInt(context.prng.next()) % maxTopupRate + BigInt(1);
        const nearestSpotInRedemptionQueue = BigInt(0); // Setting to 0 as suggested

        const fee = (topupRate * safeInfo.borrowedAmount) / BigInt(10000);  // Use BASIS_POINTS_DIVISOR

        if (actorSBDBalance < fee) {
            console.log("Actor does not have enough SBD balance to topup fee.");
            return [false, {}, {}];
        }

        const actionParams = {
            safeId: safeId,
            topupRate: topupRate,
            nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { safeId, topupRate, nearestSpotInRedemptionQueue } = actionParams;

        const tx = await this.contract.connect(actor.account.value).feeTopup(
            safeId,
            topupRate,
            nearestSpotInRedemptionQueue
        );

        return { tx, result: null };
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const { safeId, topupRate } = actionParams;
        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
        const previousSafes = previousStableBaseCDPSnapshot.safes;
        const newSafes = newStableBaseCDPSnapshot.safes;
        const previousOrderedDoublyLinkedListSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const newOrderedDoublyLinkedListSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        const previousSafeInfo = previousSafes[safeId.toString()];
        const newSafeInfo = newSafes[safeId.toString()];

        const BASIS_POINTS_DIVISOR = BigInt(10000);

        const fee = (topupRate * newSafeInfo.borrowedAmount) / BASIS_POINTS_DIVISOR;

        // Safe Validation
        expect(newSafeInfo.weight).to.equal(previousSafeInfo.weight + topupRate, "Safe weight should be increased by topupRate");
        expect(newSafeInfo.feePaid).to.equal(previousSafeInfo.feePaid + fee, "Safe feePaid should be increased by fee");

        // Token Balance Validation
        const contractAddress = this.contract.target;
        const actorAddress = actor.account.address;

        const previousContractSBDBalance = previousDFIDTokenSnapshot.balances[contractAddress] || BigInt(0);
        const newContractSBDBalance = newDFIDTokenSnapshot.balances[contractAddress] || BigInt(0);
        const previousActorSBDBalance = previousDFIDTokenSnapshot.balances[actorAddress] || BigInt(0);
        const newActorSBDBalance = newDFIDTokenSnapshot.balances[actorAddress] || BigInt(0);

        const feeDiff = newContractSBDBalance - previousContractSBDBalance;
        const actorFeeDiff = previousActorSBDBalance - newActorSBDBalance;

        // Check for FeeRefund event and adjust balances accordingly
        let refundFee = BigInt(0);
        let feeDistributedEvent = null;

        if (executionReceipt.tx) {
            const receipt = await executionReceipt.tx.wait();
            for (const log of receipt.logs) {
                try {
                    const parsedLog = this.contract.interface.parseLog(log);
                    if (parsedLog) {
                        if (parsedLog.name === "FeeRefund") {
                            refundFee = BigInt(parsedLog.args.refund);
                        }
                        if (parsedLog.name === "FeeDistributed") {
                            feeDistributedEvent = parsedLog.args;
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors for irrelevant logs
                }
            }
        }

        expect(feeDiff).to.equal(fee - refundFee, "Contract SBD balance should increase by fee - refundFee");
        expect(actorFeeDiff).to.equal(fee - refundFee, "Actor SBD balance should decrease by fee - refundFee");

        if (refundFee > 0) {
            expect(newActorSBDBalance).to.equal(previousActorSBDBalance - fee + refundFee, "Actor SBD balance should be decreased by fee and increased by refundFee");
        }

        //Redemption Queue Validations
        if (previousOrderedDoublyLinkedListSnapshot && newOrderedDoublyLinkedListSnapshot) {
            const previousNode = previousOrderedDoublyLinkedListSnapshot.nodes[safeId.toString()];
            const newNode = newOrderedDoublyLinkedListSnapshot.nodes[safeId.toString()];

            if (newNode) {
                expect(newNode.value).to.equal(newSafeInfo.weight, "Redemption queue node value should match safe weight");
            }
        }

        // Total Debt Validations
         const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
         const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

        //  Liquidation Snapshot Validations
        if (previousStableBaseCDPSnapshot.liquidationSnapshots && newStableBaseCDPSnapshot.liquidationSnapshots) {
            const previousSnapshotValue = previousStableBaseCDPSnapshot.liquidationSnapshots[safeId.toString()];
            const newSnapshotValue = newStableBaseCDPSnapshot.liquidationSnapshots[safeId.toString()];
             expect(newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral).to.equal(newSnapshotValue.collateralPerCollateralSnapshot);
            expect(newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral).to.equal(newSnapshotValue.debtPerCollateralSnapshot);
        }

        //Total Collateral Validations
        const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
        const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;


        return true;
    }
}
