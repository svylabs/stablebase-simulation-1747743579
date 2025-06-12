import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import { expect } from 'chai';
import { ethers } from 'ethers';

// Constants from StableBaseCDP.sol
const BASIS_POINTS_DIVISOR = 10000n;
const PRECISION = 10n ** 18n;
const REDEMPTION_LIQUIDATION_FEE = 75n;
const EXTRA_GAS_COMPENSATION = 100000n;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * (10n ** 18n); // 5,000,000 * 1e18

// Assumed liquidation ratio based on typical protocol values.
// This is not explicitly provided in the snapshot schema.
const LIQUIDATION_RATIO_ASSUMED = 15000n; // Represents 150% as 15000 basis points

// Helper to find an event in a receipt
function findEvent(receipt: ExecutionReceipt, eventName: string, contractAddress?: string): any | undefined {
    if (!receipt.events) return undefined;
    return receipt.events.find(event =>
        event.event === eventName && (!contractAddress || event.address.toLowerCase() === contractAddress.toLowerCase())
    );
}

// Helper to find all events of a specific type
function findAllEvents(receipt: ExecutionReceipt, eventName: string, contractAddress?: string): any[] {
    if (!receipt.events) return [];
    return receipt.events.filter(event =>
        event.event === eventName && (!contractAddress || event.address.toLowerCase() === contractAddress.toLowerCase())
    );
}

class LiquidateSafeAction extends Action {
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
        const mockPriceOracleSnapshot = currentSnapshot.contractSnapshot.mockPriceOracle;
        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
        const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;

        const availableSafeIds = Object.keys(stableBaseCDPSnapshot.safeDetails).map(BigInt);
        const validSafeIdsForLiquidation: bigint[] = [];

        const collateralPrice = mockPriceOracleSnapshot.fetchedPrice;
        if (collateralPrice === 0n) {
            context.log.info(`MockPriceOracle fetchedPrice is 0, cannot proceed with liquidation check.`);
            return [false, {}, {}];
        }

        for (const safeId of availableSafeIds) {
            const safe = stableBaseCDPSnapshot.safeDetails[safeId];

            if (!safe) {
                 // Safe might have been deleted but still in the keys if snapshot processing is partial. Skip.
                 continue;
            }

            // Rule 2 & 3: collateralAmount > 0 and borrowedAmount > 0
            if (safe.collateralAmount <= 0n || safe.borrowedAmount <= 0n) {
                continue;
            }

            // Rule 4: Must be undercollateralized
            const collateralValue = (safe.collateralAmount * collateralPrice) / PRECISION;
            const requiredCollateralValue = (safe.borrowedAmount * LIQUIDATION_RATIO_ASSUMED) / BASIS_POINTS_DIVISOR;

            if (collateralValue >= requiredCollateralValue) {
                continue; // Not undercollateralized enough for liquidation
            }

            // Rule 5: If the liquidation cannot be fully absorbed by the Stability Pool, 
            // the 'safeId' cannot be the last Safe in the 'safesOrderedForLiquidation' queue.
            // Note: stabilityPool.isLiquidationPossible(amount) returns amount <= totalStakedRaw
            const isLiquidationPossibleBySP = safe.borrowedAmount <= stabilityPoolSnapshot.totalStakedRaw;
            const isHeadOfLiquidationQueue = safeId === safesOrderedForLiquidationSnapshot.headId;

            if (!isLiquidationPossibleBySP && isHeadOfLiquidationQueue) {
                continue; // Cannot liquidate the head safe if Stability Pool cannot absorb
            }

            validSafeIdsForLiquidation.push(safeId);
        }

        if (validSafeIdsForLiquidation.length === 0) {
            context.log.info("No valid safes found for liquidation.");
            return [false, {}, {}];
        }

        const randomIndex = Number(context.prng.next() % BigInt(validSafeIdsForLiquidation.length));
        const safeIdToLiquidate = validSafeIdsForLiquidation[randomIndex];

        return [true, { safeId: safeIdToLiquidate }, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { safeId } = actionParams;
        context.log.info(`Executing liquidateSafe for safeId: ${safeId}`);

        // The liquidateSafe function is non-payable, so no value needs to be sent with the transaction.
        const tx = await this.contract.connect(actor.account.value).liquidateSafe(safeId);
        const receipt = await tx.wait();
        context.log.info(`Transaction hash: ${receipt.hash}`);
        return receipt;
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const { safeId } = actionParams;
        const previousCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
        const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
        const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;
        const previousLiquidationQueueSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const newLiquidationQueueSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const previousRedemptionQueueSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const newRedemptionQueueSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;
        const mockPriceOracleSnapshot = newSnapshot.contractSnapshot.mockPriceOracle;

        let validationPassed = true;

        context.log.info(`Validating liquidation of safeId: ${safeId}`);

        // --- Extract initial safe details from previous snapshot ---
        const initialSafeDetails = previousCDPSnapshot.safeDetails[safeId];
        expect(initialSafeDetails, `Initial safe details for safeId ${safeId} should exist`).to.not.be.undefined;
        const initialCollateralAmount = initialSafeDetails.collateralAmount;
        const initialBorrowedAmount = initialSafeDetails.borrowedAmount;
        const initialSafeOwner = previousCDPSnapshot.safeOwner[safeId];

        // --- 1. StableBaseCDP Contract State Validation ---

        // 1a. Verify that 'safes[safeId]' now returns a zero-value Safe struct (or equivalent indicating deletion).
        expect(newCDPSnapshot.safeDetails[safeId], `Safe ${safeId} should be deleted`).to.be.undefined;

        // 1b. Confirm that 'ownerOf(safeId)' for the NFT now returns the zero address, indicating the NFT has been burned.
        expect(newCDPSnapshot.safeOwner[safeId], `Owner of NFT ${safeId} should be zero address`).to.equal(ethers.ZeroAddress);

        // Determine collateral/debt change from SafeUpdated event (if applicable)
        // The event reports `collateralAmount` and `borrowedAmount` *after* updateSafe.
        let finalCollateralAmountInSafe = initialCollateralAmount;
        let finalBorrowedAmountInSafe = initialBorrowedAmount;

        const safeUpdatedEvent = findEvent(executionReceipt, 'SafeUpdated', this.contract.target as string);
        if (safeUpdatedEvent) {
            finalCollateralAmountInSafe = BigInt(safeUpdatedEvent.args.collateralAmount); // This is safe.collateralAmount AFTER _updateSafe
            finalBorrowedAmountInSafe = BigInt(safeUpdatedEvent.args.borrowedAmount); // This is safe.borrowedAmount AFTER _updateSafe
            const totalCollateralAfterUpdateSafe = BigInt(safeUpdatedEvent.args.totalCollateral); // totalCollateral after _updateSafe
            const totalDebtAfterUpdateSafe = BigInt(safeUpdatedEvent.args.totalDebt); // totalDebt after _updateSafe
            context.log.info(`SafeUpdated event found: updatedSafeCollateral=${finalCollateralAmountInSafe}, updatedSafeBorrowed=${finalBorrowedAmountInSafe}`);

            // 1c. Check that 'totalCollateral' has decreased by the actual 'collateralAmount' of the safe after updateSafe.
            const expectedTotalCollateral = totalCollateralAfterUpdateSafe - finalCollateralAmountInSafe;
            expect(newCDPSnapshot.totalCollateral, `totalCollateral mismatch`).to.equal(expectedTotalCollateral);

            // 1d. Check that 'totalDebt' has decreased by the actual 'borrowedAmount' of the safe after updateSafe.
            const expectedTotalDebt = totalDebtAfterUpdateSafe - finalBorrowedAmountInSafe;
            expect(newCDPSnapshot.totalDebt, `totalDebt mismatch`).to.equal(expectedTotalDebt);

        } else {
             context.log.info(`No SafeUpdated event found for safeId ${safeId}. Assuming no internal update and using initial amounts.`);
            // If SafeUpdated event is not emitted, then _updateSafe did not modify collateral/debt.
            // So, the amounts used for subtraction in _liquidate are the initial ones.
            const expectedTotalCollateral = previousCDPSnapshot.totalCollateral - initialCollateralAmount;
            expect(newCDPSnapshot.totalCollateral, `totalCollateral mismatch`).to.equal(expectedTotalCollateral);

            const expectedTotalDebt = previousCDPSnapshot.totalDebt - initialBorrowedAmount;
            expect(newCDPSnapshot.totalDebt, `totalDebt mismatch`).to.equal(expectedTotalDebt);
        }

        // 1e. If 'totalDebt' crossed the 'BOOTSTRAP_MODE_DEBT_THRESHOLD', verify that 'PROTOCOL_MODE' is now 'NORMAL'.
        const previousTotalDebtSnapshot = previousCDPSnapshot.totalDebt;
        const newTotalDebtSnapshot = newCDPSnapshot.totalDebt;
        const previousProtocolMode = previousCDPSnapshot.protocolMode;
        const newProtocolMode = newCDPSnapshot.protocolMode;

        if (previousTotalDebtSnapshot < BOOTSTRAP_MODE_DEBT_THRESHOLD && newTotalDebtSnapshot >= BOOTSTRAP_MODE_DEBT_THRESHOLD && previousProtocolMode === 0 /* BOOTSTRAP */) {
            expect(newProtocolMode, `PROTOCOL_MODE should transition from BOOTSTRAP to NORMAL`).to.equal(1 /* NORMAL */);
        } else {
            expect(newProtocolMode, `PROTOCOL_MODE should remain unchanged or already be NORMAL`).to.equal(previousProtocolMode);
        }

        // Determine liquidation path
        const liquidatedUsingStabilityPoolEvent = findEvent(executionReceipt, 'LiquidatedUsingStabilityPool', this.contract.target as string);
        const liquidatedUsingSecondaryMechanismEvent = findEvent(executionReceipt, 'LiquidatedUsingSecondaryMechanism', this.contract.target as string);

        // 1f. If the liquidation occurred via the secondary mechanism, verify that 'cumulativeCollateralPerUnitCollateral' and 'cumulativeDebtPerUnitCollateral' have increased.
        if (liquidatedUsingSecondaryMechanismEvent) {
            // Re-implement distributeDebtAndCollateral logic for exact validation.
            const liquidationFee = (finalCollateralAmountInSafe * REDEMPTION_LIQUIDATION_FEE) / BASIS_POINTS_DIVISOR;
            const collateralSentToDistribute = finalCollateralAmountInSafe - liquidationFee;
            const debtSentToDistribute = finalBorrowedAmountInSafe;

            const collateralToDistribute = collateralSentToDistribute + previousCDPSnapshot.collateralLoss;
            const debtToDistribute = debtSentToDistribute + previousCDPSnapshot.totalDebtLoss; // totalDebtLoss in snapshot schema for debtLoss

            // totalCollateral in distributeDebtAndCollateral is the contract's totalCollateral after the safe is removed.
            const effectiveTotalCollateralForDistribution = newCDPSnapshot.totalCollateral;

            if (effectiveTotalCollateralForDistribution === 0n) {
                // If totalCollateral is zero, distribution is effectively zero or would revert.
                // Assuming no change to cumulative values or losses in this case if it didn't revert.
                expect(newCDPSnapshot.cumulativeCollateralPerUnitCollateral).to.equal(previousCDPSnapshot.cumulativeCollateralPerUnitCollateral);
                expect(newCDPSnapshot.cumulativeDebtPerUnitCollateral).to.equal(previousCDPSnapshot.cumulativeDebtPerUnitCollateral);
                expect(newCDPSnapshot.collateralLoss).to.equal(collateralToDistribute); // All becomes loss if totalCollateral is 0
                expect(newCDPSnapshot.totalDebtLoss).to.equal(debtToDistribute);
            } else {
                const expectedCollPerUnitCollIncrease = (collateralToDistribute * PRECISION) / effectiveTotalCollateralForDistribution;
                const expectedDebtPerUnitCollIncrease = (debtToDistribute * PRECISION) / effectiveTotalCollateralForDistribution;

                expect(newCDPSnapshot.cumulativeCollateralPerUnitCollateral, `cumulativeCollateralPerUnitCollateral mismatch`).to.equal(previousCDPSnapshot.cumulativeCollateralPerUnitCollateral + expectedCollPerUnitCollIncrease);
                expect(newCDPSnapshot.cumulativeDebtPerUnitCollateral, `cumulativeDebtPerUnitCollateral mismatch`).to.equal(previousCDPSnapshot.cumulativeDebtPerUnitCollateral + expectedDebtPerUnitCollIncrease);

                const expectedCollateralLoss = collateralToDistribute - (expectedCollPerUnitCollIncrease * effectiveTotalCollateralForDistribution) / PRECISION;
                const expectedDebtLoss = debtToDistribute - (expectedDebtPerUnitCollIncrease * effectiveTotalCollateralForDistribution) / PRECISION;
                expect(newCDPSnapshot.collateralLoss, `collateralLoss mismatch`).to.equal(expectedCollateralLoss);
                expect(newCDPSnapshot.totalDebtLoss, `debtLoss mismatch`).to.equal(expectedDebtLoss);
            }
        } else {
            // If secondary mechanism not used, these should remain unchanged relative to previous snapshot (unless updateSafe changed something - but updateSafe doesn't modify these globals).
            expect(newCDPSnapshot.cumulativeCollateralPerUnitCollateral).to.equal(previousCDPSnapshot.cumulativeCollateralPerUnitCollateral);
            expect(newCDPSnapshot.cumulativeDebtPerUnitCollateral).to.equal(previousCDPSnapshot.cumulativeDebtPerUnitCollateral);
            expect(newCDPSnapshot.collateralLoss).to.equal(previousCDPSnapshot.collateralLoss);
            expect(newCDPSnapshot.totalDebtLoss).to.equal(previousCDPSnapshot.totalDebtLoss);
        }

        // 1g. Verify that the liquidator's balance has increased by the 'refund' amount as gas compensation.
        const gasCompensationPaidEvent = findEvent(executionReceipt, 'LiquidationGasCompensationPaid', this.contract.target as string);
        expect(gasCompensationPaidEvent, `LiquidationGasCompensationPaid event should be emitted`).to.not.be.undefined;
        const refundAmount = BigInt(gasCompensationPaidEvent.args.refund);
        const gasCost = BigInt(executionReceipt.gasUsed) * BigInt(executionReceipt.gasPrice || executionReceipt.effectiveGasPrice);

        const expectedLiquidatorEthBalance = previousSnapshot.accountSnapshot[actor.account.address] - gasCost + refundAmount;
        expect(newSnapshot.accountSnapshot[actor.account.address], `Liquidator's ETH balance mismatch`).to.equal(expectedLiquidatorEthBalance);


        // --- 2. OrderedDoublyLinkedList Contract State Validation ---
        // 2a. Verify that the 'safeId' node no longer exists in 'safesOrderedForLiquidation'.
        expect(newLiquidationQueueSnapshot.nodes[safeId.toString()], `Safe ${safeId} should be removed from safesOrderedForLiquidation`).to.be.undefined;

        // 2b. Verify that the 'safeId' node no longer exists in 'safesOrderedForRedemption'.
        expect(newRedemptionQueueSnapshot.nodes[safeId.toString()], `Safe ${safeId} should be removed from safesOrderedForRedemption`).to.be.undefined;

        // 2c. Check the 'head' and 'tail' pointers and the 'next'/'prev' pointers of adjacent nodes.
        const prevLiquidationNode = previousLiquidationQueueSnapshot.nodes[safeId.toString()];
        const prevRedemptionNode = previousRedemptionQueueSnapshot.nodes[safeId.toString()];

        // Validate safesOrderedForLiquidation updates
        if (prevLiquidationNode) { 
            if (safeId === previousLiquidationQueueSnapshot.headId) {
                expect(newLiquidationQueueSnapshot.headId, `Liquidation queue head should be updated`).to.equal(prevLiquidationNode.next);
                if (prevLiquidationNode.next !== 0n) {
                    expect(newLiquidationQueueSnapshot.nodes[prevLiquidationNode.next.toString()]?.prev, `New liquidation queue next head's prev should be 0`).to.equal(0n);
                }
            } else {
                expect(newLiquidationQueueSnapshot.headId, `Liquidation queue head should remain unchanged`).to.equal(previousLiquidationQueueSnapshot.headId);
            }

            if (safeId === previousLiquidationQueueSnapshot.tailId) {
                expect(newLiquidationQueueSnapshot.tailId, `Liquidation queue tail should be updated`).to.equal(prevLiquidationNode.prev);
                if (prevLiquidationNode.prev !== 0n) {
                    expect(newLiquidationQueueSnapshot.nodes[prevLiquidationNode.prev.toString()]?.next, `New liquidation queue prev tail's next should be 0`).to.equal(0n);
                }
            } else {
                expect(newLiquidationQueueSnapshot.tailId, `Liquidation queue tail should remain unchanged`).to.equal(previousLiquidationQueueSnapshot.tailId);
            }

            if (prevLiquidationNode.prev !== 0n && prevLiquidationNode.next !== 0n) {
                expect(newLiquidationQueueSnapshot.nodes[prevLiquidationNode.prev.toString()]?.next, `Previous node's next pointer in liquidation queue mismatch`).to.equal(prevLiquidationNode.next);
                expect(newLiquidationQueueSnapshot.nodes[prevLiquidationNode.next.toString()]?.prev, `Next node's prev pointer in liquidation queue mismatch`).to.equal(prevLiquidationNode.prev);
            }
        }

        // Validate safesOrderedForRedemption updates
        if (prevRedemptionNode) { 
            if (safeId === previousRedemptionQueueSnapshot.headId) {
                expect(newRedemptionQueueSnapshot.headId, `Redemption queue head should be updated`).to.equal(prevRedemptionNode.next);
                if (prevRedemptionNode.next !== 0n) {
                    expect(newRedemptionQueueSnapshot.nodes[prevRedemptionNode.next.toString()]?.prev, `New redemption queue next head's prev should be 0`).to.equal(0n);
                }
            } else {
                expect(newRedemptionQueueSnapshot.headId, `Redemption queue head should remain unchanged`).to.equal(previousRedemptionQueueSnapshot.headId);
            }

            if (safeId === previousRedemptionQueueSnapshot.tailId) {
                expect(newRedemptionQueueSnapshot.tailId, `Redemption queue tail should be updated`).to.equal(prevRedemptionNode.prev);
                if (prevRedemptionNode.prev !== 0n) {
                    expect(newRedemptionQueueSnapshot.nodes[prevRedemptionNode.prev.toString()]?.next, `New redemption queue prev tail's next should be 0`).to.equal(0n);
                }
            } else {
                expect(newRedemptionQueueSnapshot.tailId, `Redemption queue tail should remain unchanged`).to.equal(previousRedemptionQueueSnapshot.tailId);
            }

            if (prevRedemptionNode.prev !== 0n && prevRedemptionNode.next !== 0n) {
                expect(newRedemptionQueueSnapshot.nodes[prevRedemptionNode.prev.toString()]?.next, `Previous node's next pointer in redemption queue mismatch`).to.equal(prevRedemptionNode.next);
                expect(newRedemptionQueueSnapshot.nodes[prevRedemptionNode.next.toString()]?.prev, `Next node's prev pointer in redemption queue mismatch`).to.equal(prevRedemptionNode.prev);
            }
        }

        // --- 3. StabilityPool Contract State Validation ---
        const stabilityPoolContractAddress = context.contracts.stabilityPool.target as string;
        const sbdTokenContractAddress = context.contracts.dfidToken.target as string;

        if (liquidatedUsingStabilityPoolEvent) {
            // 3a. Verify that 'stabilityPool.totalStakedRaw' has decreased by the 'borrowedAmount'.
            expect(newStabilityPoolSnapshot.totalStakedRaw, `StabilityPool totalStakedRaw mismatch`).to.equal(previousStabilityPoolSnapshot.totalStakedRaw - finalBorrowedAmountInSafe);

            // 3b. Verify that 'stabilityPool.stakeScalingFactor' has been updated as expected.
            const previousSPTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
            const previousSPStakeScalingFactor = previousStabilityPoolSnapshot.stakeScalingFactor;
            const spPrecision = previousStabilityPoolSnapshot.precision;
            const spMinimumScalingFactor = previousStabilityPoolSnapshot.minimumScalingFactor;

            let expectedNewSPStakeScalingFactor: bigint;
            if (previousSPTotalStakedRaw === 0n) {
                 // This path should ideally not be taken if liquidation was performed via Stability Pool, 
                 // as `isLiquidationPossible` would have returned false.
                 expectedNewSPStakeScalingFactor = previousSPStakeScalingFactor;
            } else {
                const calculatedNewScalingFactor = ((previousSPTotalStakedRaw - finalBorrowedAmountInSafe) * spPrecision) / previousSPTotalStakedRaw;
                let calculatedCumulativeProductScalingFactor = (previousSPStakeScalingFactor * calculatedNewScalingFactor) / spPrecision;
                
                // Handle scaling factor reset
                if (calculatedCumulativeProductScalingFactor < spMinimumScalingFactor) {
                    expectedNewSPStakeScalingFactor = spPrecision; // Reset to precision
                } else {
                    expectedNewSPStakeScalingFactor = calculatedCumulativeProductScalingFactor;
                }
            }
            expect(newStabilityPoolSnapshot.stakeScalingFactor, `StabilityPool stakeScalingFactor mismatch`).to.equal(expectedNewSPStakeScalingFactor);

            // 3c. Verify that 'stabilityPool.totalCollateralPerToken' has increased and handle reset.
            const liquidationFeeAmount = (finalCollateralAmountInSafe * REDEMPTION_LIQUIDATION_FEE) / BASIS_POINTS_DIVISOR;
            const collateralSentToStabilityPool = finalCollateralAmountInSafe - liquidationFeeAmount;
            const sp_collateral_plus_loss = collateralSentToStabilityPool + previousStabilityPoolSnapshot.collateralLoss;

            let expectedSPTotalCollateralPerToken = previousStabilityPoolSnapshot.totalCollateralPerToken;
            if (previousSPTotalStakedRaw > 0n) {
                const addedCollateralPerToken = ((sp_collateral_plus_loss * previousSPStakeScalingFactor * spPrecision) / previousSPTotalStakedRaw) / spPrecision;
                expectedSPTotalCollateralPerToken = previousStabilityPoolSnapshot.totalCollateralPerToken + addedCollateralPerToken;
            }

            // Check if a reset occurred based on the calculated new scaling factor
            if (expectedNewSPStakeScalingFactor === spPrecision && previousSPStakeScalingFactor !== spPrecision) { // If reset occurred
                expect(newStabilityPoolSnapshot.totalCollateralPerToken, `StabilityPool totalCollateralPerToken should be reset to 0`).to.equal(0n);
                expect(newStabilityPoolSnapshot.totalRewardPerToken, `StabilityPool totalRewardPerToken should be reset to 0`).to.equal(0n);
                expect(newStabilityPoolSnapshot.totalSbrRewardPerToken, `StabilityPool totalSbrRewardPerToken should be reset to 0`).to.equal(0n);
                expect(newStabilityPoolSnapshot.stakeResetCount, `StabilityPool stakeResetCount should increment`).to.equal(previousStabilityPoolSnapshot.stakeResetCount + 1n);
            } else {
                 expect(newStabilityPoolSnapshot.totalCollateralPerToken, `StabilityPool totalCollateralPerToken mismatch`).to.equal(expectedSPTotalCollateralPerToken);
            }

            // 3d. If 'totalStakedRaw' in Stability Pool became zero, verify that 'StableBaseCDP.stabilityPoolCanReceiveRewards' is 'false'.
            if (newStabilityPoolSnapshot.totalStakedRaw === 0n && previousStabilityPoolSnapshot.rewardSenderActive) {
                expect(newCDPSnapshot.stabilityPoolRewardsEnabled, `stabilityPoolCanReceiveRewards should be false`).to.be.false;
            } else {
                expect(newCDPSnapshot.stabilityPoolRewardsEnabled, `stabilityPoolCanReceiveRewards should remain unchanged`).to.equal(previousCDPSnapshot.stabilityPoolRewardsEnabled);
            }

            // 3e. collateralLoss in StabilityPool should be updated.
            let expectedSPCollateralLoss = 0n;
            if (previousSPTotalStakedRaw > 0n) {
                const addedCollateralPerToken = ((sp_collateral_plus_loss * previousSPStakeScalingFactor * spPrecision) / previousSPTotalStakedRaw) / spPrecision;
                expectedSPCollateralLoss = sp_collateral_plus_loss - (((addedCollateralPerToken * previousSPTotalStakedRaw * spPrecision) / previousSPStakeScalingFactor) / spPrecision);
            } else {
                 expectedSPCollateralLoss = previousStabilityPoolSnapshot.collateralLoss; 
            }
            expect(newStabilityPoolSnapshot.collateralLoss, `StabilityPool collateralLoss mismatch`).to.equal(expectedSPCollateralLoss);

        } else {
            // If Stability Pool was NOT used, its state variables should remain unchanged (assuming no other actions).
            expect(newStabilityPoolSnapshot.totalStakedRaw).to.equal(previousStabilityPoolSnapshot.totalStakedRaw);
            expect(newStabilityPoolSnapshot.stakeScalingFactor).to.equal(previousStabilityPoolSnapshot.stakeScalingFactor);
            expect(newStabilityPoolSnapshot.totalCollateralPerToken).to.equal(previousStabilityPoolSnapshot.totalCollateralPerToken);
            expect(newStabilityPoolSnapshot.collateralLoss).to.equal(previousStabilityPoolSnapshot.collateralLoss);
        }

        // --- 4. DFIDToken (SBD Token) Contract State Validation ---
        if (liquidatedUsingStabilityPoolEvent) {
            // 4a. Verify that 'sbdToken.balanceOf(address(stabilityPool))' has decreased by the 'borrowedAmount'.
            const prevSPTokenBalance = previousDFIDTokenSnapshot.accountBalances[stabilityPoolContractAddress];
            expect(newDFIDTokenSnapshot.accountBalances[stabilityPoolContractAddress], `SBD Token balance of Stability Pool mismatch`).to.equal(prevSPTokenBalance - finalBorrowedAmountInSafe);

            // 4b. Verify that 'sbdToken.totalSupply' has decreased by the 'borrowedAmount'.
            expect(newDFIDTokenSnapshot.tokenTotalSupply, `SBD Token totalSupply mismatch`).to.equal(previousDFIDTokenSnapshot.tokenTotalSupply - finalBorrowedAmountInSafe);

            // 4c. Verify that 'sbdToken.totalBurned' has increased by the 'borrowedAmount'.
            expect(newDFIDTokenSnapshot.totalTokensBurned, `SBD Token totalBurned mismatch`).to.equal(previousDFIDTokenSnapshot.totalTokensBurned + finalBorrowedAmountInSafe);
        } else {
            // If Stability Pool was not used, SBD token state should not change due to this action
            expect(newDFIDTokenSnapshot.accountBalances[stabilityPoolContractAddress]).to.equal(previousDFIDTokenSnapshot.accountBalances[stabilityPoolContractAddress]);
            expect(newDFIDTokenSnapshot.tokenTotalSupply).to.equal(previousDFIDTokenSnapshot.tokenTotalSupply);
            expect(newDFIDTokenSnapshot.totalTokensBurned).to.equal(previousDFIDTokenSnapshot.totalTokensBurned);
        }

        // --- 5. DFIREStaking Contract State Validation ---
        const liquidationFeePaidEvent = findEvent(executionReceipt, 'LiquidationFeePaid', this.contract.target as string);
        const dfireStakingContractAddress = context.contracts.dfireStaking.target as string;

        if (liquidationFeePaidEvent && liquidationFeePaidEvent.args.recipient.toLowerCase() === dfireStakingContractAddress.toLowerCase()) {
            const feeReceivedByDFIREStaking = BigInt(liquidationFeePaidEvent.args.amount);
            const previousDFIRETotalStake = previousDFIREStakingSnapshot.totalStake;
            let expectedDFIRETotalCollateralPerToken = previousDFIREStakingSnapshot.totalCollateralPerToken;

            if (previousDFIRETotalStake > 0n) {
                expectedDFIRETotalCollateralPerToken += (feeReceivedByDFIREStaking * PRECISION) / previousDFIRETotalStake;
            }
            expect(newDFIREStakingSnapshot.totalCollateralPerToken, `DFIREStaking totalCollateralPerToken mismatch`).to.equal(expectedDFIRETotalCollateralPerToken);
        } else {
            expect(newDFIREStakingSnapshot.totalCollateralPerToken, `DFIREStaking totalCollateralPerToken should not change`).to.equal(previousDFIREStakingSnapshot.totalCollateralPerToken);
        }
        
        // --- 6. Event Emission Validation ---

        // 6a. Verify the emission of a 'SafeUpdated' event from 'StableBaseCDP'. (Already checked implicitly)

        // 6b. Verify the emission of either 'LiquidatedUsingStabilityPool' or 'LiquidatedUsingSecondaryMechanism' event from 'StableBaseCDP'.
        const cdpContractAddress = this.contract.target as string;
        expect(liquidatedUsingStabilityPoolEvent || liquidatedUsingSecondaryMechanismEvent, `Either LiquidatedUsingStabilityPool or LiquidatedUsingSecondaryMechanism event must be emitted`).to.not.be.undefined;
        expect(!(liquidatedUsingStabilityPoolEvent && liquidatedUsingSecondaryMechanismEvent), `Only one of LiquidatedUsingStabilityPool or LiquidatedUsingSecondaryMechanism can be emitted`).to.be.true;

        // 6c. Verify the emission of 'SafeRemovedFromLiquidationQueue' and 'SafeRemovedFromRedemptionQueue' events from 'StableBaseCDP'.
        expect(findEvent(executionReceipt, 'SafeRemovedFromLiquidationQueue', cdpContractAddress), `SafeRemovedFromLiquidationQueue event missing`).to.not.be.undefined;
        expect(findEvent(executionReceipt, 'SafeRemovedFromRedemptionQueue', cdpContractAddress), `SafeRemovedFromRedemptionQueue event missing`).to.not.be.undefined;

        // 6d. Verify the emission of a 'RemovedSafe' event from 'StableBaseCDP'.
        expect(findEvent(executionReceipt, 'RemovedSafe', cdpContractAddress), `RemovedSafe event missing`).to.not.be.undefined;

        // 6e. Verify the emission of a 'Transfer' (ERC721 burn) event from 'StableBaseCDP' with the 'to' address as zero.
        const transferEvents = findAllEvents(executionReceipt, 'Transfer', cdpContractAddress);
        const burnEvent = transferEvents.find(e => BigInt(e.args.tokenId) === safeId && e.args.from.toLowerCase() === initialSafeOwner.toLowerCase() && e.args.to.toLowerCase() === ethers.ZeroAddress.toLowerCase());
        expect(burnEvent, `ERC721 Transfer (burn) event to zero address for safeId ${safeId} missing`).to.not.be.undefined;

        // 6f. Verify the emission of a 'LiquidationGasCompensationPaid' event from 'StableBaseCDP'. (Already checked)

        // 6g. Verify the conditional emission of a 'LiquidationFeePaid' event from 'StableBaseCDP'. (Already checked)

        // 6h. If Stability Pool liquidation occurred, verify the emission of a 'LiquidationPerformed' event from 'StabilityPool' and potentially 'ScalingFactorReset'.
        if (liquidatedUsingStabilityPoolEvent) {
            expect(findEvent(executionReceipt, 'LiquidationPerformed', stabilityPoolContractAddress), `LiquidationPerformed event from StabilityPool missing`).to.not.be.undefined;
            // Check for ScalingFactorReset based on calculated new scaling factor
            const previousSPStakeScalingFactor = previousStabilityPoolSnapshot.stakeScalingFactor;
            const spPrecision = previousStabilityPoolSnapshot.precision;
            const spMinimumScalingFactor = previousStabilityPoolSnapshot.minimumScalingFactor;
            const previousSPTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;

            if (previousSPTotalStakedRaw > 0n) {
                const calculatedNewScalingFactorForResetCheck = ((previousSPTotalStakedRaw - finalBorrowedAmountInSafe) * spPrecision) / previousSPTotalStakedRaw;
                const calculatedCumulativeProductScalingFactorForResetCheck = (previousSPStakeScalingFactor * calculatedNewScalingFactorForResetCheck) / spPrecision;
                
                if (calculatedCumulativeProductScalingFactorForResetCheck < spMinimumScalingFactor) {
                    expect(findEvent(executionReceipt, 'ScalingFactorReset', stabilityPoolContractAddress), `ScalingFactorReset event from StabilityPool missing`).to.not.be.undefined;
                }
            }
        }

        // 6i. If SBD tokens were burned, verify the emission of a 'Burn' event from 'sbdToken'.
        if (liquidatedUsingStabilityPoolEvent) {
            expect(findEvent(executionReceipt, 'Burn', sbdTokenContractAddress), `Burn event from DFIDToken (sbdToken) missing`).to.not.be.undefined;
        }

        // 6j. If DFIRE staking pool received a fee, verify the emission of a 'CollateralRewardAdded' event from 'dfireTokenStaking'.
        if (liquidationFeePaidEvent && liquidationFeePaidEvent.args.recipient.toLowerCase() === dfireStakingContractAddress.toLowerCase()) {
            expect(findEvent(executionReceipt, 'CollateralRewardAdded', dfireStakingContractAddress), `CollateralRewardAdded event from DFIREStaking missing`).to.not.be.undefined;
        }

        // 6k. If Stability Pool received a fee (as a fallback), verify the emission of a 'CollateralRewardAdded' event from 'StabilityPool'.
        // Check if the recipient in LiquidationFeePaid event was StabilityPoolContractAddress
        if (liquidationFeePaidEvent && liquidationFeePaidEvent.args.recipient.toLowerCase() === stabilityPoolContractAddress.toLowerCase()) {
            expect(findEvent(executionReceipt, 'CollateralRewardAdded', stabilityPoolContractAddress), `CollateralRewardAdded event from StabilityPool missing`).to.not.be.undefined;
        }

        context.log.info("LiquidateSafeAction validation completed.");
        return validationPassed;
    }
}
