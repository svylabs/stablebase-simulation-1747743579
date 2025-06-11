import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
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
        const safeOwners = stableBaseCDPSnapshot.safeOwners;
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
        const actorAddress = actor.account.address;
        let safeIdToTopup: bigint | undefined = undefined;

        for (const safeId in safeOwners) {
            if (safeOwners[safeId] === actorAddress) {
                safeIdToTopup = BigInt(safeId);
                break;
            }
        }

        if (!safeIdToTopup) {
            console.log("No safe owned by the actor.");
            return [false, {}, {}];
        }

        const safe = stableBaseCDPSnapshot.safes[safeIdToTopup.toString()];

        if (!safe) {
            console.log("Safe not found.");
            return [false, {}, {}];
        }

        const balance = dfidTokenSnapshot.balances[actorAddress] || 0n;
        if (balance <= 0n) {
            console.log("Actor has no DFID tokens.");
            return [false, {}, {}];
        }

        // Initialize topupRate randomly based on snapshot data, ensuring it's within reasonable bounds
        const maxTopupRate = 1000n; // Example upper bound
        const topupRate = (BigInt(context.prng.next()) % maxTopupRate) + 1n; // Ensure topupRate is greater than 0

        const fee = (topupRate * safe.borrowedAmount) / 10000n;

        if (balance < fee) {
            console.log("Insufficient balance to pay fee.");
            return [false, {}, {}];
        }

        const nearestSpotInRedemptionQueue = 0n; // Let contract find the nearest spot automatically

        const actionParams = {
            safeId: safeIdToTopup,
            topupRate: topupRate,
            nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
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
        const tx = await this.contract
            .connect(actor.account.value)
            .feeTopup(safeId, topupRate, nearestSpotInRedemptionQueue);
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
        const { safeId, topupRate } = actionParams;
        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
        const previousOrderedDoublyLinkedListSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const newOrderedDoublyLinkedListSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        const actorAddress = actor.account.address;
        const stableBaseCDPAddress = (context.contracts.stableBaseCDP as any).target;
        const dfidTokenAddress = (context.contracts.dfidToken as any).target;

        // Safe State validation
        const previousSafe = previousStableBaseCDPSnapshot.safes[safeId.toString()];
        const newSafe = newStableBaseCDPSnapshot.safes[safeId.toString()];

        if (!previousSafe || !newSafe) {
            console.log("Safe not found in snapshots.");
            return false;
        }

        expect(newSafe.weight).to.equal(previousSafe.weight + topupRate, "Safe's weight should be increased by topupRate.");

        const fee = (topupRate * previousSafe.borrowedAmount) / 10000n;
        expect(newSafe.feePaid).to.equal(previousSafe.feePaid + fee, "Safe's feePaid should be increased by the calculated fee.");

        // Token Balances validation
        const previousActorBalance = previousDFIDTokenSnapshot.balances[actorAddress] || 0n;
        const newActorBalance = newDFIDTokenSnapshot.balances[actorAddress] || 0n;
        const previousContractBalance = previousDFIDTokenSnapshot.balances[stableBaseCDPAddress] || 0n;
        const newContractBalance = newDFIDTokenSnapshot.balances[stableBaseCDPAddress] || 0n;

        expect(newActorBalance).to.equal(previousActorBalance - fee, "Message sender's SBD token balance should be decreased by the fee amount.");
        expect(newContractBalance).to.equal(previousContractBalance + fee, "Contract's SBD token balance should be increased by the fee amount.");

        // Redemption Queue validation
        if (previousOrderedDoublyLinkedListSnapshot && newOrderedDoublyLinkedListSnapshot) {
          const previousNode = previousOrderedDoublyLinkedListSnapshot.nodes[safeId.toString()];
          const newNode = newOrderedDoublyLinkedListSnapshot.nodes[safeId.toString()];

          if (newNode) {
              expect(newNode.value).to.equal(newSafe.weight, "Node value should be updated to the new weight");
              // More sophisticated queue validation would be needed here
          }
        }

        // Event Emission validation
        const feeTopupEvent = executionReceipt.receipt.logs.find(
            (log: any) => log.topics[0] === ethers.keccak256(ethers.toUtf8Bytes("FeeTopup(uint256,uint256,uint256,uint256)"))
        );

        if (!feeTopupEvent) {
            console.log("FeeTopup event not emitted.");
            return false;
        }

        const parsedFeeTopupEvent = new ethers.Interface(["event FeeTopup(uint256 safeId, uint256 topupRate, uint256 feePaid, uint256 weight)"]).parseLog(feeTopupEvent);

        expect(parsedFeeTopupEvent.args.safeId).to.equal(safeId, "FeeTopup event safeId should match");
        expect(parsedFeeTopupEvent.args.topupRate).to.equal(topupRate, "FeeTopup event topupRate should match");
        //expect(parsedFeeTopupEvent.args.feePaid).to.equal(fee, "FeeTopup event feePaid should match");
        expect(parsedFeeTopupEvent.args.weight).to.equal(newSafe.weight, "FeeTopup event weight should match");

        //Distribute Fees Event
        const feeDistributedEvent = executionReceipt.receipt.logs.find(
            (log: any) => log.topics[0] === ethers.keccak256(ethers.toUtf8Bytes("FeeDistributed(uint256,uint256,bool,uint256,uint256,uint256)"))
        );
        
        if (!feeDistributedEvent) {
            console.log("FeeDistributed event not emitted.");
            return false;
        }

        // Additional validations for FeeDistribution, TotalDebt, LiquidationSnapshot can be added here based on the event parameters, if emitted.

        return true;
    }
}
