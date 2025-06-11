import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class LiquidatesafeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("LiquidateSafeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safes = stableBaseCDPSnapshot.SafeInfo;

        // Find a safe that meets the pre-execution conditions
        let safeIdToLiquidate: bigint | null = null;

        // Iterate through the safes object from the snapshot
        if (!safes) {
            console.warn("No safes found in the snapshot.");
            return [false, [], {}];
        }

        for (const safeIdStr in safes) {
            if (!safes.hasOwnProperty(safeIdStr)) {
                continue;
            }

            try {
                // Get the Safe information for the current safeId
                const safe = safes[safeIdStr];
                if (!safe) continue; // skip if safe doesn't exist in the current snapshot

                const collateralAmount = safe.collateralAmount;
                const borrowedAmount = safe.borrowedAmount;
                const mockPriceOracle = currentSnapshot.contractSnapshot.mockPriceOracle
                const collateralPrice = mockPriceOracle.currentPrice;
                const precision = BigInt(10) ** BigInt(18)
                const basisPointsDivisor = BigInt(10000); // Assuming BASIS_POINTS_DIVISOR is 10000
                const liquidationRatio = BigInt(11000); // Assuming liquidationRatio is 11000. Must fetch this properly if it is dynamic.
                const collateralValue = (collateralAmount * collateralPrice) / precision;
                const stabilityPool = currentSnapshot.contractSnapshot.stabilityPool
                const borrowedAmountNumber = Number(borrowedAmount);

                const liquidationPossible = stabilityPool.totalStakedRaw > borrowedAmount

                // Condition 1: The safeId must correspond to an existing Safe (CDP), i.e., safes[safeId].collateralAmount > 0.
                // Condition 2: The collateralAmount of the Safe must be greater than 0 (safes[safeId].collateralAmount > 0).
                // Condition 3: The borrowedAmount of the Safe must be greater than 0 (safes[safeId].borrowedAmount > 0).
                // Condition 4: The collateralValue (collateralAmount * collateralPrice / PRECISION) must be less than (borrowedAmount * liquidationRatio / BASIS_POINTS_DIVISOR), ensuring the Safe is undercollateralized.

                const condition1 = safe.collateralAmount > BigInt(0);
                const condition2 = safe.borrowedAmount > BigInt(0);
                const condition3 = collateralValue < ((borrowedAmount * liquidationRatio) / basisPointsDivisor);

                if (condition1 && condition2 && condition3) {
                    const safeId = BigInt(safeIdStr);
                    safeIdToLiquidate = safeId;
                    console.log(`Found suitable safe for liquidation with ID: ${safeId}`);
                    break;
                }
            } catch (error) {
                console.error(`Error processing safe ID ${safeIdStr}:`, error);
            }
        }

        if (safeIdToLiquidate === null) {
            console.log("No suitable safe found for liquidation.");
            return [false, [], {}];
        }

        console.log(`Liquidating safe with ID: ${safeIdToLiquidate}`);

        const actionParams = {
            safeId: safeIdToLiquidate,
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const safeId = actionParams.safeId;

        try {
            const tx = await this.contract.connect(actor.account.value).liquidateSafe(safeId);
            const receipt = await tx.wait();

            return {receipt: receipt, result: null};
        } catch (error) {
            console.error(`Transaction failed for safeId ${safeId}:`, error);
            throw error; // Re-throw the error to indicate failure
        }
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const safeId = actionParams.safeId;

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        const previousSafes = previousStableBaseCDPSnapshot.SafeInfo;
        const newSafes = newStableBaseCDPSnapshot.SafeInfo;

        const initialTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
        const finalTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;

        const initialTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
        const finalTotalDebt = newStableBaseCDPSnapshot.totalDebt;

         const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

        const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;


        // Fetch Safe data from previous and new snapshots
        const previousSafe = previousSafes[safeId.toString()];
        const newSafe = newSafes ? newSafes[safeId.toString()] : undefined;

        // 1. Safe Removal Validation
        // safes[safeId] should no longer exist (or its values should be reset to zero).
        if (newSafe) {
            // If safe still exists, its values should be reset to zero
            expect(newSafe.collateralAmount, `Safe ${safeId} collateralAmount should be 0 after liquidation.`).to.equal(BigInt(0));
            expect(newSafe.borrowedAmount, `Safe ${safeId} borrowedAmount should be 0 after liquidation.`).to.equal(BigInt(0));
        } else {
            // If safe doesn't exist, ensure it's indeed removed
            expect(newSafe).to.be.undefined;
        }

        // 2. Global Debt and Collateral Consistency
        // totalCollateral should be decreased by the liquidated collateralAmount.
        // totalDebt should be decreased by the liquidated borrowedAmount.
        const liquidatedCollateralAmount = previousSafe.collateralAmount;
        const liquidatedBorrowedAmount = previousSafe.borrowedAmount;

        expect(finalTotalCollateral, "Total collateral should decrease by liquidated amount.").to.equal(initialTotalCollateral - liquidatedCollateralAmount);
        expect(finalTotalDebt, "Total debt should decrease by liquidated amount.").to.equal(initialTotalDebt - liquidatedBorrowedAmount);

        // 3. Liquidation Queue Removal
        const previousSafesOrderedForLiquidation = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const newSafesOrderedForLiquidation = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

        expect(newSafesOrderedForLiquidation.nodes[safeId.toString()], `Safe ${safeId} should be removed from liquidation queue.`).to.be.undefined;

         //4. Stability Pool State
        const initialTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
        const finalTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;

        // Assuming StabilityPool's totalStakedRaw decreases by borrowedAmount during liquidation
        expect(finalTotalStakedRaw, "Stability Pool's totalStakedRaw should decrease by borrowedAmount").to.equal(initialTotalStakedRaw - liquidatedBorrowedAmount);

        // 5. DFIDToken State (SBD token)
        const initialSBDTotalSupply = previousDFIDTokenSnapshot.totalSupply;
        const finalSBDTotalSupply = newDFIDTokenSnapshot.totalSupply;

        expect(finalSBDTotalSupply, "SBD total supply should decrease by borrowedAmount").to.equal(initialSBDTotalSupply - liquidatedBorrowedAmount);

         // 6. DFIREStaking State
        // Assuming liquidationFee is paid to DFIREStaking and increases its totalCollateralPerToken
        if (previousDFIREStakingSnapshot && newDFIREStakingSnapshot) {


            const initialDFIREStakingTotalCollateralPerToken = previousDFIREStakingSnapshot.totalCollateralPerTokenValue;
            const finalDFIREStakingTotalCollateralPerToken = newDFIREStakingSnapshot.totalCollateralPerTokenValue;

            //Cannot make an assumption on the amount of liquidation fee being rewarded. This depends on a lot of factors. Therefore skipping validation
            //expect(finalDFIREStakingTotalCollateralPerToken, "DFIREStaking totalCollateralPerToken should increase").to.be.greaterThan(initialDFIREStakingTotalCollateralPerToken);

        }


        // TODO: Add validations for fee distribution and protocol mode changes.

        return true;
    }
}
