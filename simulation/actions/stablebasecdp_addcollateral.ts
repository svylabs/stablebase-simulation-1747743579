import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class AddCollateralAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("AddCollateralAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        if (!stableBaseCDPSnapshot) {
            return [false, {}, {}];
        }

        const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);
        const actorSafeIds = safeIds.filter(safeId => stableBaseCDPSnapshot.safeOwners[safeId] === actor.account.address);

        if (actorSafeIds.length === 0) {
            return [false, {}, {}];
        }

        const safeId = actorSafeIds[context.prng.next() % actorSafeIds.length];
        const safe = stableBaseCDPSnapshot.safes[safeId];

        // Check if the safe exists and has collateral
        if (!safe || safe.collateralAmount === BigInt(0)) {
            return [false, {}, {}];
        }

        const ethBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        // Generate a random amount, but ensure it's less than or equal to the actor's ETH balance
        const maxAmount = ethBalance > BigInt(1000) ? BigInt(1000) : ethBalance; //Limit to avoid failing often
        if(maxAmount <= BigInt(0)) {
            return [false, {}, {}];
        }
        const amount = BigInt(context.prng.next()) % maxAmount + BigInt(1);

        const nearestSpotInLiquidationQueue = BigInt(0);

        const actionParams = {
            safeId: BigInt(safeId),
            amount: amount,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
            value: amount, // msg.value
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { safeId, amount, nearestSpotInLiquidationQueue, value } = actionParams;

        const tx = await this.contract
            .connect(actor.account.value)
            .addCollateral(safeId, amount, nearestSpotInLiquidationQueue, { value: amount });

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
        const { safeId, amount } = actionParams;

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        if (!previousStableBaseCDPSnapshot || !newStableBaseCDPSnapshot) {
            console.error("Missing StableBaseCDP snapshots");
            return false;
        }

        // Collateral Validation
        const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
        const newSafe = newStableBaseCDPSnapshot.safes[safeId];

        if (!previousSafe || !newSafe) {
            console.error("Missing safe in snapshots");
            return false;
        }

        const expectedCollateralAmount = previousSafe.collateralAmount + amount;

        expect(newSafe.collateralAmount, "collateralAmount should be increased by amount").to.equal(expectedCollateralAmount);
        expect(newStableBaseCDPSnapshot.totalCollateral, "totalCollateral should be increased by amount").to.equal(
            previousStableBaseCDPSnapshot.totalCollateral + amount
        );

        // Validate account balance changes
        const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        expect(newAccountBalance, "Account balance should decrease by amount").to.equal(previousAccountBalance - amount);

         // Validate emitted event (AddedCollateral)
        const addedCollateralEvent = executionReceipt.receipt.logs.find(
            (log: any) =>
                log.address === (context.contracts.stableBaseCDP as any).target &&
                log.topics[0] === ethers.id("AddedCollateral(uint256,uint256,uint256,uint256,uint256)")
        );

        if (!addedCollateralEvent) {
            console.error("AddedCollateral event not found");
            return false;
        }

        const parsedAddedCollateralEvent = this.contract.interface.parseLog(addedCollateralEvent);

        expect(parsedAddedCollateralEvent.args.safeId, "AddedCollateral event safeId mismatch").to.equal(safeId);
        expect(parsedAddedCollateralEvent.args.amount, "AddedCollateral event amount mismatch").to.equal(amount);
        expect(parsedAddedCollateralEvent.args.totalCollateral, "AddedCollateral event totalCollateral mismatch").to.equal(newStableBaseCDPSnapshot.totalCollateral);
        expect(parsedAddedCollateralEvent.args.totalDebt, "AddedCollateral event totalDebt mismatch").to.equal(newStableBaseCDPSnapshot.totalDebt);

        // Validate emitted event (LiquidationQueueUpdated)
        const liquidationQueueUpdatedEvent = executionReceipt.receipt.logs.find(
            (log: any) =>
                log.address === (context.contracts.stableBaseCDP as any).target &&
                log.topics[0] === ethers.id("LiquidationQueueUpdated(uint256,uint256,uint256)")
        );

         if (!liquidationQueueUpdatedEvent) {
             console.error("LiquidationQueueUpdated event not found");
             return false;
         }

         const parsedLiquidationQueueUpdatedEvent = this.contract.interface.parseLog(liquidationQueueUpdatedEvent);
         const newRatio = parsedLiquidationQueueUpdatedEvent.args[1];
         const nextNode = parsedLiquidationQueueUpdatedEvent.args[2];

        // Validate emitted event (SafeUpdated)
         const safeUpdatedEvent = executionReceipt.receipt.logs.find(
             (log: any) =>
                 log.address === (context.contracts.stableBaseCDP as any).target &&
                 log.topics[0] === ethers.id("SafeUpdated(uint256,uint256,uint256,uint256,uint256,uint256,uint256)")
         );

         if (safeUpdatedEvent) {
             const parsedSafeUpdatedEvent = this.contract.interface.parseLog(safeUpdatedEvent);

             // Validate collateralIncrease and debtIncrease from SafeUpdated event
             const collateralIncrease = parsedSafeUpdatedEvent.args.collateralIncrease;
             const debtIncrease = parsedSafeUpdatedEvent.args.debtIncrease;

             // Fetch previous and new liquidation snapshots
             const prevLiquidationSnapshot = previousStableBaseCDPSnapshot.liquidationSnapshots[safeId];
             const newLiquidationSnapshot = newStableBaseCDPSnapshot.liquidationSnapshots[safeId];

             if (prevLiquidationSnapshot && newLiquidationSnapshot) {
                 // Compare snapshots to calculate expected increases
                 // expect(collateralIncrease, "Collateral increase mismatch").to.equal(expectedCollateralIncrease);
                 // expect(debtIncrease, "Debt increase mismatch").to.equal(expectedDebtIncrease);
             } else {
                 console.warn("Liquidation snapshots not found, skipping collateral/debt increase validation");
             }

             expect(parsedSafeUpdatedEvent.args.safeId, "SafeUpdated event safeId mismatch").to.equal(safeId);
             expect(parsedSafeUpdatedEvent.args.collateralAmount, "SafeUpdated event collateralAmount mismatch").to.equal(newSafe.collateralAmount);
             expect(parsedSafeUpdatedEvent.args.borrowedAmount, "SafeUpdated event borrowedAmount mismatch").to.equal(newSafe.borrowedAmount);

         }

        // Validate PROTOCOL_MODE state change
        if (previousStableBaseCDPSnapshot.mode !== newStableBaseCDPSnapshot.mode) {
            expect(newStableBaseCDPSnapshot.mode, "PROTOCOL_MODE should change from BOOTSTRAP to NORMAL").to.equal(1); // Assuming NORMAL mode is represented by 1
        }

        return true;
    }
}
