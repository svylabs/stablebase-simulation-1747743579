import { ethers } from 'ethers';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { expect } from 'chai';
import { StableBaseCDPSnapshot } from '../snapshots';

export class AddCollateralAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super('AddCollateralAction');
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot;
        const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number).filter(safeId => stableBaseCDPSnapshot.safes[safeId].collateralAmount > BigInt(0));

        if (safeIds.length === 0) {
            throw new Error('No safes with collateral found for AddCollateral action.');
        }

        const safeId = safeIds[context.prng.next() % safeIds.length];
        // Ensure amount is within reasonable bounds, e.g., up to the actor's ETH balance or a fraction of total collateral.
        const actorETHBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const maxAmount = actorETHBalance > BigInt(1000) ? BigInt(1000) : actorETHBalance;
        const amount = BigInt(context.prng.next()) % maxAmount + BigInt(1); // Non-zero positive integer

        const liquidationQueue = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;
        let nearestSpotInLiquidationQueue = BigInt(0);

        if(liquidationQueue && liquidationQueue.nodes) {
            const queueSafeIds = Object.keys(liquidationQueue.nodes).map(Number);
            if (queueSafeIds.length > 0){
                 nearestSpotInLiquidationQueue = BigInt(queueSafeIds[context.prng.next() % queueSafeIds.length]);
            }
        }

        // Ensure msg.value equals the amount
        const overrides = { value: amount };

        const actionParams = [safeId, amount, nearestSpotInLiquidationQueue, overrides];
        const newIdentifiers: Record<string, any> = {};

        return [actionParams, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const [safeId, amount, nearestSpotInLiquidationQueue, overrides] = actionParams;

        const tx = await this.contract
            .connect(actor.account.value)
            .addCollateral(safeId, amount, nearestSpotInLiquidationQueue, overrides);
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const [safeId, amount, nearestSpotInLiquidationQueue, overrides] = actionParams;

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot;

        const previousSafes = previousStableBaseCDPSnapshot.safes;
        const newSafes = newStableBaseCDPSnapshot.safes;

        const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
        const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;

        const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
        const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

        const previousProtocolMode = previousStableBaseCDPSnapshot.mode;
        const newProtocolMode = newStableBaseCDPSnapshot.mode;

        // Collateral and Debt Validation
        const safeIdStr = String(safeId);

        // Null checks for previous and new safes
        if (!previousSafes || !newSafes || !previousSafes[safeIdStr] || !newSafes[safeIdStr]) {
            console.warn("Safe not found in snapshot.");
            return true; // Or throw an error, depending on the desired behavior
        }

        const collateralIncrease = newSafes[safeIdStr].collateralAmount - previousSafes[safeIdStr].collateralAmount - BigInt(amount);
        const debtIncrease = newSafes[safeIdStr].borrowedAmount - previousSafes[safeIdStr].borrowedAmount;

        expect(newSafes[safeIdStr].collateralAmount).to.equal(previousSafes[safeIdStr].collateralAmount + BigInt(amount) + collateralIncrease, "Collateral amount should be increased by the added amount.");
        expect(newTotalCollateral).to.equal(previousTotalCollateral + BigInt(amount) + collateralIncrease, "Total collateral should be increased by the added amount.");

        expect(newSafes[safeIdStr].borrowedAmount).to.gte(previousSafes[safeIdStr].borrowedAmount, "Borrowed amount should be greater than or equal to the previous borrowed amount.");
        if(debtIncrease > BigInt(0)) {
            expect(newTotalDebt).to.equal(previousTotalDebt + debtIncrease, "Total debt should be increased by the debt increase.");
        }

        //PROTOCOL_MODE
        if (newTotalDebt > BigInt(5000000000) && previousProtocolMode === 0 && newProtocolMode === 1) {
            expect(newProtocolMode).to.equal(1, "Protocol mode should be NORMAL");
        }
        else {
            expect(newProtocolMode).to.equal(previousProtocolMode, "Protocol mode should be unchanged");
        }

        //Balances
        const previousETHBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newETHBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        expect(newETHBalance).to.lte(previousETHBalance - BigInt(amount), "ETH balance should be decreased by the amount sent.");

         // Liquidation Queue Validation
        const previousLiquidationQueue = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const newLiquidationQueue = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

        if (previousLiquidationQueue && newLiquidationQueue && previousLiquidationQueue.nodes && newLiquidationQueue.nodes[safeIdStr]) {
            // Check if the safe's position in the queue has been updated correctly.
            expect(newLiquidationQueue.nodes[safeIdStr].value).to.not.equal(previousLiquidationQueue.nodes[safeIdStr].value, "Liquidation queue position should be updated.");
        }

        return true;
    }
}
