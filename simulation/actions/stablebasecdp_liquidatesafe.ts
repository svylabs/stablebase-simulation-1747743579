import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
import { expect } from 'chai';

export class LiquidatesafeAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("LiquidateSafeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        let safeIdToLiquidate: bigint | undefined = undefined;

        if (stableBaseCDPSnapshot.safes) {
            const safeIds = Object.keys(stableBaseCDPSnapshot.safes);
            for (const safeId of safeIds) {\n                if (!stableBaseCDPSnapshot.safes.hasOwnProperty(safeId)) continue;
                const safe = stableBaseCDPSnapshot.safes[safeId];
                if (safe.collateralAmount > BigInt(0) && safe.borrowedAmount > BigInt(0)) {
                    const liquidationRatio = BigInt(15000); // Example: 150%
                    const BASIS_POINTS_DIVISOR = BigInt(10000); // Example: 10000

                    const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
                    const collateralPrice = mockPriceOracleSnapshot.price;

                    const collateralValue = (safe.collateralAmount * collateralPrice) / BigInt(10 ** 18); // Assuming 18 decimals for price
                    const requiredCollateralValue = (safe.borrowedAmount * liquidationRatio) / BASIS_POINTS_DIVISOR;

                    if (collateralValue < requiredCollateralValue) {
                        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
                        const safesOrderedForLiquidationAddress = stableBaseCDPSnapshot.safesOrderedForLiquidation;
                        const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;
                        const isLiquidationPossible = stabilityPoolSnapshot.liquidationPossible;
                        const head = safesOrderedForLiquidationSnapshot.head;

                        if (isLiquidationPossible || (safeId !== head.toString() && head !== BigInt(0))) {
                            safeIdToLiquidate = BigInt(safeId);
                            break;
                        }
                    }
                }
            }
        }

        if (!safeIdToLiquidate) {
            throw new Error("No suitable safeId found for liquidation.");
        }

        const actionParams = {
            safeId: safeIdToLiquidate
        };

        return [actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { safeId } = actionParams;

        try {
            const tx = await this.contract.connect(actor.account.value).liquidateSafe(safeId);
            await tx.wait();
        } catch (error: any) {
            console.error("Execution error while liquidating safeId", safeId, ":", error);
            throw new Error(`Liquidation failed for safeId ${safeId}: ${error.message}`);
        }
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const { safeId } = actionParams;

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        // General Checks
        if (!newStableBaseCDPSnapshot.safes || newStableBaseCDPSnapshot.safes[safeId]) {
            expect.fail(`Safe with ID ${safeId} should no longer exist in the 'safes' mapping.`);
        }

        // Queues Checks
        const previousSafesOrderedForLiquidationSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const newSafesOrderedForLiquidationSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

        const previousSafesOrderedForRedemptionSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const newSafesOrderedForRedemptionSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        expect(newSafesOrderedForLiquidationSnapshot.head).to.not.equal(BigInt(safeId), `Safe with ID ${safeId} should be removed from the liquidation queue.`);
        expect(newSafesOrderedForRedemptionSnapshot.head).to.not.equal(BigInt(safeId), `Safe with ID ${safeId} should be removed from the redemption queue.`);

        // Total Collateral and Debt Checks
        const previousCollateralAmount = previousStableBaseCDPSnapshot.safes[safeId]?.collateralAmount || BigInt(0);
        const previousBorrowedAmount = previousStableBaseCDPSnapshot.safes[safeId]?.borrowedAmount || BigInt(0);

        expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(previousStableBaseCDPSnapshot.totalCollateral - previousCollateralAmount, "Total collateral should decrease.");
        expect(newStableBaseCDPSnapshot.totalDebt).to.equal(previousStableBaseCDPSnapshot.totalDebt - previousBorrowedAmount, "Total debt should decrease.");

        // Protocol Mode Check
        const BOOTSTRAP_MODE_DEBT_THRESHOLD = BigInt(1000000000000000000); // Example value, use actual value from contract
        if (previousStableBaseCDPSnapshot.mode === 0 && newStableBaseCDPSnapshot.mode === 1) { // 0: Bootstrap, 1: Normal
            expect(previousStableBaseCDPSnapshot.totalDebt).to.be.lte(BOOTSTRAP_MODE_DEBT_THRESHOLD, "Previous debt should be within Bootstrap threshold.");
            expect(newStableBaseCDPSnapshot.totalDebt).to.be.gt(BOOTSTRAP_MODE_DEBT_THRESHOLD, "New debt should exceed Bootstrap threshold.");
        }

        // Stability Pool Liquidation Checks
        const stabilityPoolSnapshotPrevious = previousSnapshot.contractSnapshot.stabilityPool;
        const stabilityPoolSnapshotNew = newSnapshot.contractSnapshot.stabilityPool;

        if (stabilityPoolSnapshotPrevious.liquidationPossible) {
            expect(stabilityPoolSnapshotNew.totalStakedRaw).to.equal(stabilityPoolSnapshotPrevious.totalStakedRaw - borrowedAmount, "Total staked raw in stability pool should decrease.");

            // Add checks for SBD token balance decrease in StabilityPool if applicable in snapshot
        }

        // Secondary Mechanism Liquidation Checks
        if (!stabilityPoolSnapshotPrevious.liquidationPossible) {
            expect(newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral).to.be.gte(previousStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral, "Cumulative collateral per unit collateral should increase or remain same.");
            expect(newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral).to.be.gte(previousStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral, "Cumulative debt per unit collateral should increase or remain same.");
            expect(newStableBaseCDPSnapshot.collateralLoss).to.be.gte(previousStableBaseCDPSnapshot.collateralLoss, "Collateral loss should increase or remain same.");
            expect(newStableBaseCDPSnapshot.debtLoss).to.be.gte(previousStableBaseCDPSnapshot.debtLoss, "Debt loss should increase or remain same.");
        }

        // Fee Distribution Checks (adapt based on how fees are tracked in snapshots)
        // Add logic to check fee distribution to dfireTokenStaking and stabilityPool

        // ERC721 Token Burn Check
        // Assuming `ownerOf` is available in the snapshot and returns address(0) after burn
        if (newStableBaseCDPSnapshot.ownerOf && newStableBaseCDPSnapshot.ownerOf[safeId]) {
          expect(newStableBaseCDPSnapshot.ownerOf[safeId]).to.equal(ethers.ZeroAddress, `ERC721 token for safeId ${safeId} should be burned (owner should be address(0)).`);
        }

        // Account and Token Balance Checks (Adapt to specific tokens and accounts)
        const actorAddress = actor.account.address;
        // Add checks for relevant token balances affected by the liquidation


        return true;
    }
}
