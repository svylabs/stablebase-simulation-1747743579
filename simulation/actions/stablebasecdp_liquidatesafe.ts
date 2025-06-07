import { ethers } from 'ethers';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { expect } from 'chai';

import {
    DFIREStakingSnapshot,
    StabilityPoolSnapshot,
    StableBaseCDPSnapshot,
    OrderedDoublyLinkedListSnapshot,
    DFIDTokenSnapshot,
    MockPriceOracleSnapshot
} from '../snapshots';

export class LiquidateSafeAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super('LiquidateSafeAction');
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot
            .stableBaseCDP as StableBaseCDPSnapshot;

        // Find a safeId that exists in the safes mapping.
        let safeId: bigint | undefined;
        if (stableBaseCDPSnapshot.safes) {
            const safeIds = Object.keys(stableBaseCDPSnapshot.safes);

            if (safeIds.length > 0) {
                safeId = BigInt(safeIds[context.prng.next() % safeIds.length]);
            } else {
                // If there are no safes, we cannot proceed with liquidation.
                throw new Error('No safes available for liquidation.');
            }
        } else {
            throw new Error('No safes available for liquidation.');
        }

        if (!safeId) {
            throw new Error('No safes available for liquidation.');
        }
        const actionParams = [safeId];
        const newIdentifiers: Record<string, any> = {};

        return [actionParams, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const [safeId] = actionParams;

        const tx = await this.contract
            .connect(actor.account.value)
            .liquidateSafe(safeId);

        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const [safeId] = actionParams;

        const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot;
        const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP as StableBaseCDPSnapshot;

        const safesPrevious = stableBaseCDPPrevious?.safes;
        const safesNew = stableBaseCDPNew?.safes;

        const totalCollateralPrevious = stableBaseCDPPrevious.totalCollateral;
        const totalCollateralNew = stableBaseCDPNew.totalCollateral;

        const totalDebtPrevious = stableBaseCDPPrevious.totalDebt;
        const totalDebtNew = stableBaseCDPNew.totalDebt;

        const previousSafe = safesPrevious && safesPrevious[safeId.toString()];
        const newSafe = safesNew && safesNew[safeId.toString()];

        const stableBaseAddress = (context.contracts.stableBaseCDP as any).target;

        // Safe should be removed from the `safes` mapping
        expect(safesNew && safesNew[safeId.toString()], 'Safe should be removed').to.be
            .undefined;

        // Total collateral and debt should decrease
        if (previousSafe) {
            expect(totalCollateralNew, 'Total collateral should decrease').to.be.lt(
                totalCollateralPrevious
            );
            expect(totalDebtNew, 'Total debt should decrease').to.be.lt(totalDebtPrevious);
        }

        //Contract Balance Validation
        const stableBasePreviousBalance = previousSnapshot.accountSnapshot[stableBaseAddress] || BigInt(0);
        const stableBaseNewBalance = newSnapshot.accountSnapshot[stableBaseAddress] || BigInt(0);
        expect(stableBaseNewBalance, 'StableBase CDP balance should remain same or increase').to.be.gte(stableBasePreviousBalance);

        // Stability Pool Validation
        const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool as StabilityPoolSnapshot | undefined;
        const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool as StabilityPoolSnapshot | undefined;

        if (stabilityPoolPrevious && stabilityPoolNew) {
            const sbdTokenPrevious = previousSnapshot.contractSnapshot.dfidToken as DFIDTokenSnapshot;
            const sbdTokenNew = newSnapshot.contractSnapshot.dfidToken as DFIDTokenSnapshot;
            const previousTotalSupply = sbdTokenPrevious.totalTokenSupply;
            const newTotalSupply = sbdTokenNew.totalTokenSupply;

            expect(newTotalSupply, 'Total supply should decrease').to.be.lt(previousTotalSupply);

        }

        //OrderedDoublyLinkedList Validation for liquidation queue
        const safesOrderedForLiquidationPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation as OrderedDoublyLinkedListSnapshot;
        const safesOrderedForLiquidationNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation as OrderedDoublyLinkedListSnapshot;

        if (safesOrderedForLiquidationPrevious && safesOrderedForLiquidationNew) {
            if (safesOrderedForLiquidationPrevious.nodes[safeId.toString()]) {
                expect(safesOrderedForLiquidationNew.nodes[safeId.toString()], 'Safe should be removed from liquidation queue').to.be.undefined;
            }
        }

        //OrderedDoublyLinkedList Validation for redemption queue
        const safesOrderedForRedemptionPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption as OrderedDoublyLinkedListSnapshot;
        const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption as OrderedDoublyLinkedListSnapshot;

        if (safesOrderedForRedemptionPrevious && safesOrderedForRedemptionNew) {
            if (safesOrderedForRedemptionPrevious.nodes[safeId.toString()]) {
                expect(safesOrderedForRedemptionNew.nodes[safeId.toString()], 'Safe should be removed from redemption queue').to.be.undefined;
            }
        }

        return true;
    }
} 