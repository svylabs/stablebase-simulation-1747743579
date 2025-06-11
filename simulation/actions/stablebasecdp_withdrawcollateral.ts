import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class WithdrawCollateralAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("WithdrawCollateralAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        if (!stableBaseCDPSnapshot) {
            console.warn("StableBaseCDP snapshot not found");
            return [false, {}, {}];
        }

        const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);
        if (safeIds.length === 0) {
            console.warn("No safes found");
            return [false, {}, {}];
        }

        let safeId: number | undefined;
        let safe: any | undefined;

        for (const id of safeIds) {
            if (stableBaseCDPSnapshot.safeOwners[id] === actor.account.address) {
                safeId = id;
                safe = stableBaseCDPSnapshot.safes[id];
                break;
            }
        }

        if (safeId === undefined || safe === undefined) {
            console.warn("No safe found for this actor");
            return [false, {}, {}];
        }

        if (safe.collateralAmount <= BigInt(0)) {
            console.warn("No collateral to withdraw");
            return [false, {}, {}];
        }

        let amount: bigint;
        let nearestSpotInLiquidationQueue = BigInt(0);

        if (safe.borrowedAmount > BigInt(0)) {
            const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
            if (!mockPriceOracleSnapshot) {
                console.warn("MockPriceOracle snapshot not found");
                return [false, {}, {}];
            }
            const price = mockPriceOracleSnapshot.price;
            const liquidationRatio = BigInt(1500000000000000000); // Example liquidation ratio
            const PRECISION = BigInt(10) ** BigInt(18);
            const BASIS_POINTS_DIVISOR = BigInt(10000);
            const maxWithdrawal = safe.collateralAmount - (safe.borrowedAmount * liquidationRatio * PRECISION) / (price * BASIS_POINTS_DIVISOR);

            if (maxWithdrawal <= BigInt(0)) {
                console.warn("Max withdrawal amount is zero");
                return [false, {}, {}];
            }

            amount = BigInt(Math.floor(context.prng.next() % Number(maxWithdrawal)));
            if (amount <= BigInt(0)) {
                amount = BigInt(1);
            }


            const safesOrderedForLiquidation = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;
            if(safesOrderedForLiquidation && safesOrderedForLiquidation.head !== BigInt(0)){
                nearestSpotInLiquidationQueue = safesOrderedForLiquidation.head;
            }
        } else {
            amount = BigInt(Math.floor(context.prng.next() % Number(safe.collateralAmount)));
            if (amount <= BigInt(0)) {
                amount = BigInt(1);
            }
        }

        const actionParams = {
            safeId: BigInt(safeId),
            amount: amount,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;
        const tx = await this.contract.connect(actor.account.value).withdrawCollateral(
            safeId,
            amount,
            nearestSpotInLiquidationQueue
        );
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
            console.warn("StableBaseCDP snapshot not found");
            return false;
        }

        const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
        const newSafe = newStableBaseCDPSnapshot.safes[safeId];

        if (!previousSafe || !newSafe) {
            console.warn("Safe not found in snapshot");
            return false;
        }

        // Validate safe.collateralAmount
        expect(newSafe.collateralAmount).to.equal(previousSafe.collateralAmount - amount, "Incorrect collateral amount after withdrawal");

        // Validate totalCollateral
        expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(previousStableBaseCDPSnapshot.totalCollateral - amount, "Incorrect total collateral after withdrawal");

        // Validate ETH balance of the actor
        const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        expect(newAccountBalance).to.equal(previousAccountBalance + amount, "Incorrect ETH balance after withdrawal");

        let liquidationQueueUpdatedEvent;
        let safeRemovedFromLiquidationQueueEvent;
        let safeRemovedFromRedemptionQueueEvent;

        // Validate borrowedAmount, liquidationRatio, and safesOrderedForLiquidation if borrowedAmount > 0
        if (previousSafe.borrowedAmount > BigInt(0)) {
            //  Fetch LiquidationQueueUpdated event
             liquidationQueueUpdatedEvent = executionReceipt.receipt.logs.find(
                (log: any) => log.address === (context.contracts.safesOrderedForLiquidation as any).target && log.topics[0] === ethers.utils.id("LiquidationQueueUpdated(uint256,uint256,uint256)")
            );

            if (liquidationQueueUpdatedEvent) {
                const parsedEvent = (context.contracts.safesOrderedForLiquidation as any).interface.parseLog(liquidationQueueUpdatedEvent);

                // Now you can access the event arguments using parsedEvent.args
                const newRatio = parsedEvent.args[1];

                const expectedNewRatio = (previousSafe.borrowedAmount * BigInt(10) ** BigInt(18)) / (previousSafe.collateralAmount - amount);
                expect(newRatio).to.equal(expectedNewRatio, "Incorrect new liquidation ratio");

            }

            const safesOrderedForLiquidation = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
            // need to validate the linked list

        } else {
            //  Implement SafeRemovedFromLiquidationQueue and SafeRemovedFromRedemptionQueue events and corresponding state changes here
            //  You need to check that the safe has been removed from both queues
             safeRemovedFromLiquidationQueueEvent = executionReceipt.receipt.logs.find(
                (log: any) => log.address === (context.contracts.safesOrderedForLiquidation as any).target && log.topics[0] === ethers.utils.id("SafeRemovedFromLiquidationQueue(uint256)")
            );

             safeRemovedFromRedemptionQueueEvent = executionReceipt.receipt.logs.find(
                (log: any) => log.address === (context.contracts.safesOrderedForRedemption as any).target && log.topics[0] === ethers.utils.id("SafeRemovedFromRedemptionQueue(uint256)")
            );

            expect(safeRemovedFromLiquidationQueueEvent).to.not.be.undefined;
            expect(safeRemovedFromRedemptionQueueEvent).to.not.be.undefined;

            const safesOrderedForLiquidation = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
            expect(safesOrderedForLiquidation.nodes[safeId]).to.be.undefined;

        }

        // Validate totalDebt
         expect(newStableBaseCDPSnapshot.totalDebt).to.equal(previousStableBaseCDPSnapshot.totalDebt, "Incorrect total debt after withdrawal");

        // Validate liquidationSnapshots updates
         if (previousStableBaseCDPSnapshot.liquidationSnapshots && previousStableBaseCDPSnapshot.liquidationSnapshots[safeId]) {
            const previousLiquidationSnapshot = previousStableBaseCDPSnapshot.liquidationSnapshots[safeId];
            const newLiquidationSnapshot = newStableBaseCDPSnapshot.liquidationSnapshots[safeId];

            if (previousLiquidationSnapshot.collateralPerCollateralSnapshot !== newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral) {
                // Check if liquidationSnapshots[safeId].debtPerCollateralSnapshot is updated correctly
                expect(newLiquidationSnapshot.debtPerCollateralSnapshot).to.equal(newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral, "Incorrect debtPerCollateralSnapshot");

                //  Check if liquidationSnapshots[safeId].collateralPerCollateralSnapshot is updated correctly
                expect(newLiquidationSnapshot.collateralPerCollateralSnapshot).to.equal(newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral, "Incorrect collateralPerCollateralSnapshot");
            }
        }

        // Validate PROTOCOL_MODE updates
        if (previousStableBaseCDPSnapshot.totalDebt > previousStableBaseCDPSnapshot.bootstrapModeDebtThreshold && previousStableBaseCDPSnapshot.mode === 0) {
            //  Implement logic to validate PROTOCOL_MODE updates
            //  Check if PROTOCOL_MODE is updated to NORMAL
            expect(newStableBaseCDPSnapshot.mode).to.equal(1, "Incorrect PROTOCOL_MODE");
        }

        return true;
    }
}
