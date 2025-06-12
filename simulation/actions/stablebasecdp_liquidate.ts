import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from 'chai';
import {ethers} from 'ethers';

// Constants as BigInt
const BASIS_POINTS_DIVISOR = 10000n;
const PRECISION = 10n**18n;
const EXTRA_GAS_COMPENSATION = 100000n;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * PRECISION;

class LiquidateAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("LiquidateAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const safesOrderedForLiquidationTailId = currentSnapshot.contractSnapshot.safesOrderedForLiquidation.tailId;

        // A Safe must exist in the 'safesOrderedForLiquidation' queue.
        // If the tail is 0, it means the queue is empty.
        if (safesOrderedForLiquidationTailId === 0n) {
            return [false, {}, {}];
        }

        // The `liquidate()` function does not require any direct parameters as input.
        // Pre-execution parameter generation rules state that no direct parameters are needed.
        // Other pre-conditions (e.g., safe being liquidatable, non-zero collateral/debt)
        // are internal contract checks that would cause a revert if not met. 
        // The `initialize` function primarily determines if the action can be attempted with valid parameters.
        // Since no parameters are needed, and a safe exists to potentially liquidate,
        // the action can be attempted.
        return [true, {}, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        // The `liquidate` function is `nonpayable` and takes no inputs.
        // Any ETH for liquidation or gas compensation, if applicable, is transferred from
        // the `StableBaseCDP` contract's own balance, not `msg.value` from the caller.
        return await this.contract.connect(actor.account.value).liquidate();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const stableBaseCDPAddress = context.contracts.stableBaseCDP.target as string;
        const stabilityPoolAddress = context.contracts.stabilityPool.target as string;
        const dfireStakingAddress = context.contracts.dfireStaking.target as string;
        const sbdTokenAddress = context.contracts.dfidToken.target as string;

        // Retrieve event data to determine transaction outcomes and values
        let _safeId: bigint | undefined; // The ID of the liquidated safe
        let borrowedAmountLiquidated: bigint | undefined; // The amount of debt from the liquidated safe
        let collateralAmountLiquidated: bigint | undefined; // The amount of collateral from the liquidated safe
        let refundAmount: bigint = 0n; 
        let liquidationFeePaidAmount: bigint = 0n; // Actual fee transferred to staking/stability pool
        let valueTransferredToStabilityPool: bigint = 0n; // Collateral transferred from CDP to StabilityPool
        let stabilityPoolUsedForLiquidation = false;
        let safeUpdatedEventEmitted = false;
        let collateralIncreaseFromUpdate: bigint = 0n;
        let debtIncreaseFromUpdate: bigint = 0n;
        let prevSafeOwner: string | undefined;

        // Get the safe ID that was at the tail of the liquidation queue before execution.
        _safeId = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.tailId;
        expect(_safeId, "Safe ID from liquidation queue tail should not be 0").to.not.equal(0n);
        
        // Get the previous owner of the safe NFT.
        prevSafeOwner = previousSnapshot.contractSnapshot.stableBaseCDP.safeOwner[_safeId.toString()];
        expect(prevSafeOwner, `Previous owner for safe ${_safeId} not found`).to.not.be.undefined;

        // Filter relevant events from the transaction receipt.
        const relevantEvents = executionReceipt.events.filter(event => 
            event.fragment.name === 'LiquidatedUsingStabilityPool' ||
            event.fragment.name === 'LiquidatedUsingSecondaryMechanism' ||
            event.fragment.name === 'SafeUpdated' ||
            event.fragment.name === 'RemovedSafe' ||
            event.fragment.name === 'Transfer' || // ERC721 burn event
            event.fragment.name === 'LiquidationGasCompensationPaid' ||
            event.fragment.name === 'LiquidationFeePaid' ||
            event.fragment.name === 'LiquidationPerformed' || // From StabilityPool
            event.fragment.name === 'Burn' || // From DFIDToken
            event.fragment.name === 'CollateralRewardAdded' ||
            event.fragment.name === 'SafeRemovedFromLiquidationQueue' ||
            event.fragment.name === 'SafeRemovedFromRedemptionQueue' ||
            event.fragment.name === 'ScalingFactorReset'
        );

        // Parse event arguments to extract relevant data.
        for (const event of relevantEvents) {
            if (event.fragment.name === 'LiquidatedUsingStabilityPool') {
                stabilityPoolUsedForLiquidation = true;
                expect(event.args._safeId).to.equal(_safeId); // Ensure safeId matches
                borrowedAmountLiquidated = event.args.borrowedAmount;
                collateralAmountLiquidated = event.args.collateralAmount;
            } else if (event.fragment.name === 'LiquidatedUsingSecondaryMechanism') {
                stabilityPoolUsedForLiquidation = false;
                expect(event.args._safeId).to.equal(_safeId); // Ensure safeId matches
                borrowedAmountLiquidated = event.args.borrowedAmount;
                collateralAmountLiquidated = event.args.collateralAmount;
            } else if (event.fragment.name === 'SafeUpdated') {
                safeUpdatedEventEmitted = true;
                expect(event.args._safeId).to.equal(_safeId); // Ensure safeId matches
                collateralIncreaseFromUpdate = event.args.collateralIncrease;
                debtIncreaseFromUpdate = event.args.debtIncrease;
            } else if (event.fragment.name === 'LiquidationGasCompensationPaid') {
                expect(event.args.safeId).to.equal(_safeId); // Ensure safeId matches
                refundAmount = event.args.refund;
            } else if (event.fragment.name === 'LiquidationFeePaid') {
                expect(event.args.safeId).to.equal(_safeId); // Ensure safeId matches
                liquidationFeePaidAmount = event.args.amount; // This is the amount actually sent to a pool
            } else if (event.fragment.name === 'LiquidationPerformed') { // From StabilityPool
                valueTransferredToStabilityPool = event.args.collateral; // This is ETH sent to StabilityPool by StableBaseCDP
            }
        }

        // Assert that core liquidation amounts were captured from events.
        expect(borrowedAmountLiquidated, "Borrowed amount from liquidation event must be set").to.not.be.undefined;
        expect(collateralAmountLiquidated, "Collateral amount from liquidation event must be set").to.not.be.undefined;

        // 1. Core Liquidation Outcome Validation
        const liquidationEventEmitted = relevantEvents.some(e => e.fragment.name === 'LiquidatedUsingStabilityPool') ||
                                       relevantEvents.some(e => e.fragment.name === 'LiquidatedUsingSecondaryMechanism');
        expect(liquidationEventEmitted, "Either LiquidatedUsingStabilityPool or LiquidatedUsingSecondaryMechanism event must be emitted.").to.be.true;

        // Calculate expected `totalCollateral` and `totalDebt` changes, accounting for potential `_updateSafe` call.
        let expectedPrevTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
        let expectedPrevTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;

        if (safeUpdatedEventEmitted) {
            expectedPrevTotalCollateral += collateralIncreaseFromUpdate;
            expectedPrevTotalDebt += debtIncreaseFromUpdate;
        }

        expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral, "StableBaseCDP totalCollateral mismatch").to.equal(expectedPrevTotalCollateral - collateralAmountLiquidated!); 
        expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebt, "StableBaseCDP totalDebt mismatch").to.equal(expectedPrevTotalDebt - borrowedAmountLiquidated!); 

        // Verify that the 'Safe' struct for the liquidated ID is effectively deleted.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safeDetails[_safeId!.toString()], `Safe ${_safeId} should be deleted`).to.be.undefined;

        // Verify that the owner of the safe NFT ('_ownerOf(_safeId)') is now address(0).
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safeOwner[_safeId!.toString()], `Safe owner for ${_safeId} should be address(0)`).to.equal(ethers.ZeroAddress);
        
        // _tokenApprovals[_safeId] is set to address(0) during burn. However, this mapping is not exposed in the snapshot.
        // Therefore, direct validation via snapshot is not possible for this specific state change.

        // Verify that the ERC721 balance of the previous owner of the safe NFT has decreased by 1.
        const prevOwnerBalanceBefore = previousSnapshot.contractSnapshot.stableBaseCDP.balanceOfSafes[prevSafeOwner!] || 0n;
        const prevOwnerBalanceAfter = newSnapshot.contractSnapshot.stableBaseCDP.balanceOfSafes[prevSafeOwner!] || 0n; 
        expect(prevOwnerBalanceAfter, `Balance of previous owner ${prevSafeOwner} should decrease by 1`).to.equal(prevOwnerBalanceBefore - 1n);


        // 2. Queue State Validation
        // Verify that the liquidated safe ID is no longer present in the 'safesOrderedForLiquidation' linked list nodes.
        expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[_safeId!.toString()], `Safe ${_safeId} should be removed from liquidation queue nodes`).to.be.undefined;
        expect(relevantEvents.some(e => e.fragment.name === 'SafeRemovedFromLiquidationQueue'), "SafeRemovedFromLiquidationQueue event not emitted").to.be.true;

        // Verify that the liquidated safe ID is no longer present in the 'safesOrderedForRedemption' linked list nodes.
        expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[_safeId!.toString()], `Safe ${_safeId} should be removed from redemption queue nodes`).to.be.undefined;
        expect(relevantEvents.some(e => e.fragment.name === 'SafeRemovedFromRedemptionQueue'), "SafeRemovedFromRedemptionQueue event not emitted").to.be.true;

        // Verify head/tail pointers of the ordered linked lists are updated correctly.
        const prevLiquidationNode = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[_safeId.toString()];
        if (prevLiquidationNode) { // Only if the node existed before (which it should for liquidation)
            if (prevLiquidationNode.prev === 0n) { // If it was the head
                expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.headId, "Liquidation queue head not updated correctly").to.equal(prevLiquidationNode.next);
            }
            // If the node was not the tail, its next node's prev pointer should point to its prev
            if (prevLiquidationNode.next !== 0n) {
                const nextNodeOfLiquidatedInPrev = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[prevLiquidationNode.next.toString()];
                expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[nextNodeOfLiquidatedInPrev.value.toString()]?.prev, "Liquidation queue: next node's prev pointer not updated").to.equal(prevLiquidationNode.prev);
            }
            if (prevLiquidationNode.next === 0n) { // If it was the tail
                expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.tailId, "Liquidation queue tail not updated correctly").to.equal(prevLiquidationNode.prev);
            }
            // If the node was not the head, its prev node's next pointer should point to its next
            if (prevLiquidationNode.prev !== 0n) {
                const prevNodeOfLiquidatedInPrev = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[prevLiquidationNode.prev.toString()];
                expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[prevNodeOfLiquidatedInPrev.value.toString()]?.next, "Liquidation queue: prev node's next pointer not updated").to.equal(prevLiquidationNode.next);
            }
        }

        const prevRedemptionNode = previousSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[_safeId.toString()];
        if (prevRedemptionNode) { // Only if the node existed before (which it should if it was in the redemption queue)
            if (prevRedemptionNode.prev === 0n) { // If it was the head
                expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.headId, "Redemption queue head not updated correctly").to.equal(prevRedemptionNode.next);
            }
            if (prevRedemptionNode.next !== 0n) {
                const nextNodeOfLiquidatedInPrev = previousSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[prevRedemptionNode.next.toString()];
                expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[nextNodeOfLiquidatedInPrev.value.toString()]?.prev, "Redemption queue: next node's prev pointer not updated").to.equal(prevRedemptionNode.prev);
            }
            if (prevRedemptionNode.next === 0n) { // If it was the tail
                expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.tailId, "Redemption queue tail not updated correctly").to.equal(prevRedemptionNode.prev);
            }
            if (prevRedemptionNode.prev !== 0n) {
                const prevNodeOfLiquidatedInPrev = previousSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[prevRedemptionNode.prev.toString()];
                expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[prevNodeOfLiquidatedInPrev.value.toString()]?.next, "Redemption queue: prev node's next pointer not updated").to.equal(prevRedemptionNode.next);
            }
        }

        // 3. StabilityPool Specific Validation (Conditional)
        const prevStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

        if (stabilityPoolUsedForLiquidation) {
            expect(newStabilityPoolSnapshot.totalStakedRaw, "StabilityPool totalStakedRaw mismatch").to.equal(prevStabilityPoolSnapshot.totalStakedRaw - borrowedAmountLiquidated!); 

            const scalingFactorResetEventEmitted = relevantEvents.some(e => e.fragment.name === 'ScalingFactorReset');
            if (scalingFactorResetEventEmitted) {
                expect(newStabilityPoolSnapshot.stakeScalingFactor, "StabilityPool stakeScalingFactor not reset to PRECISION").to.equal(PRECISION);
                expect(newStabilityPoolSnapshot.totalCollateralPerToken, "StabilityPool totalCollateralPerToken not reset to 0").to.equal(0n);
                expect(newStabilityPoolSnapshot.totalRewardPerToken, "StabilityPool totalRewardPerToken not reset to 0").to.equal(0n);
                expect(newStabilityPoolSnapshot.totalSbrRewardPerToken, "StabilityPool totalSbrRewardPerToken not reset to 0").to.equal(0n);
                expect(newStabilityPoolSnapshot.stakeResetCount, "StabilityPool stakeResetCount not incremented").to.equal(prevStabilityPoolSnapshot.stakeResetCount + 1n);

                // Verify the new snapshot entry (the last one added)
                const newResetCount = newStabilityPoolSnapshot.stakeResetCount;
                expect(newStabilityPoolSnapshot.stakeResetSnapshots.length, "stakeResetSnapshots length mismatch").to.equal(Number(newResetCount));
                const lastResetSnapshot = newStabilityPoolSnapshot.stakeResetSnapshots[Number(newResetCount - 1n)]; 
                
                // Find the ScalingFactorReset event to get expected values from event args
                const resetEvent = relevantEvents.find(e => e.fragment.name === 'ScalingFactorReset');
                if (resetEvent) {
                    const eventSnapshot = resetEvent.args.snapshot; 
                    expect(lastResetSnapshot.scalingFactor, "Last reset snapshot scalingFactor mismatch").to.equal(eventSnapshot.scalingFactor);
                    expect(lastResetSnapshot.totalRewardPerToken, "Last reset snapshot totalRewardPerToken mismatch").to.equal(eventSnapshot.totalRewardPerToken);
                    expect(lastResetSnapshot.totalCollateralPerToken, "Last reset snapshot totalCollateralPerToken mismatch").to.equal(eventSnapshot.totalCollateralPerToken);
                    expect(lastResetSnapshot.totalSBRRewardPerToken, "Last reset snapshot totalSBRRewardPerToken mismatch").to.equal(eventSnapshot.totalSBRRewardPerToken);
                } else {
                    // This case should ideally not happen if scalingFactorResetEventEmitted is true
                    expect.fail("ScalingFactorReset event not found despite flag indicating it was emitted.");
                }

            } else {
                // If no reset, stakeScalingFactor should be updated based on liquidation formula.
                if (prevStabilityPoolSnapshot.totalStakedRaw > 0n) {
                    const newScalingFactorFactor = ((prevStabilityPoolSnapshot.totalStakedRaw - borrowedAmountLiquidated!) * PRECISION) / prevStabilityPoolSnapshot.totalStakedRaw;
                    const expectedStakeScalingFactor = (prevStabilityPoolSnapshot.stakeScalingFactor * newScalingFactorFactor) / PRECISION;
                    expect(newStabilityPoolSnapshot.stakeScalingFactor, "StabilityPool stakeScalingFactor mismatch").to.equal(expectedStakeScalingFactor);
                } else {
                     // If totalStakedRaw was 0 and no reset, scaling factor should not change.
                     expect(newStabilityPoolSnapshot.stakeScalingFactor, "StabilityPool stakeScalingFactor should not change if totalStakedRaw was 0 and no reset").to.equal(prevStabilityPoolSnapshot.stakeScalingFactor);
                }
            }

            // Verify that 'stabilityPool.totalCollateralPerToken' and 'collateralLoss' have been updated.
            // These are complex calculations; we verify they have changed meaningfully unless no change was expected (e.g., if totalStakedRaw was 0 before).
            if (prevStabilityPoolSnapshot.totalStakedRaw !== 0n && !scalingFactorResetEventEmitted) {
                expect(newStabilityPoolSnapshot.totalCollateralPerToken, "StabilityPool totalCollateralPerToken should have changed").to.not.equal(prevStabilityPoolSnapshot.totalCollateralPerToken);
                expect(newStabilityPoolSnapshot.collateralLoss, "StabilityPool collateralLoss should have changed").to.not.equal(prevStabilityPoolSnapshot.collateralLoss);
            }

            // If `stabilityPool.totalStakedRaw` became zero, verify that `StableBaseCDP.stabilityPoolCanReceiveRewards` is 'false'.
            if (newStabilityPoolSnapshot.totalStakedRaw === 0n && previousSnapshot.contractSnapshot.stabilityPool.rewardSenderActive) {
                expect(newSnapshot.contractSnapshot.stableBaseCDP.stabilityPoolRewardsEnabled, "StableBaseCDP stabilityPoolCanReceiveRewards should be false").to.be.false;
            }

        } else { // 4. Secondary Mechanism Specific Validation (Conditional)
            expect(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral, "StableBaseCDP cumulativeCollateralPerUnitCollateral should have increased").to.be.above(previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral);
            expect(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral, "StableBaseCDP cumulativeDebtPerUnitCollateral should have increased").to.be.above(previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral);
            expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateralLoss, "StableBaseCDP collateralLoss should have changed").to.not.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateralLoss);
            expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebtLoss, "StableBaseCDP debtLoss should have changed").to.not.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalDebtLoss);
        }

        // 5. DFIDToken Specific Validation (Conditional)
        const prevDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
        if (stabilityPoolUsedForLiquidation) {
            const prevStabilityPoolSBDBalance = prevDfidTokenSnapshot.accountBalances[stabilityPoolAddress] || 0n;
            expect(newDfidTokenSnapshot.accountBalances[stabilityPoolAddress], "DFIDToken balance of StabilityPool mismatch").to.equal(prevStabilityPoolSBDBalance - borrowedAmountLiquidated!); 
            expect(newDfidTokenSnapshot.tokenTotalSupply, "DFIDToken totalSupply mismatch").to.equal(prevDfidTokenSnapshot.tokenTotalSupply - borrowedAmountLiquidated!); 
            expect(newDfidTokenSnapshot.totalTokensBurned, "DFIDToken totalBurned mismatch").to.equal(prevDfidTokenSnapshot.totalTokensBurned + borrowedAmountLiquidated!); 
            expect(relevantEvents.some(e => e.fragment.name === 'Burn' && e.address === sbdTokenAddress), "Burn event from DFIDToken not emitted").to.be.true;
        }

        // 6. Fee and Compensation Validation (ETH Balances)
        const gasCost = executionReceipt.gasUsed * executionReceipt.effectiveGasPrice;

        // Actor's ETH Balance
        const expectedActorEthBalance = previousSnapshot.accountSnapshot[actor.account.address] - gasCost + refundAmount;
        expect(newSnapshot.accountSnapshot[actor.account.address], "Actor ETH balance mismatch after refund").to.equal(expectedActorEthBalance);

        // Contract ETH Balances
        let expectedCdpEthBalance = previousSnapshot.accountSnapshot[stableBaseCDPAddress] || 0n;
        let expectedDfireStakingEthBalance = previousSnapshot.accountSnapshot[dfireStakingAddress] || 0n;
        let expectedStabilityPoolEthBalance = previousSnapshot.accountSnapshot[stabilityPoolAddress] || 0n;

        // CDP pays refund to actor
        expectedCdpEthBalance -= refundAmount;

        // If StabilityPool is used, CDP sends collateral amount (valueTransferredToStabilityPool) to it.
        if (stabilityPoolUsedForLiquidation) {
            expectedCdpEthBalance -= valueTransferredToStabilityPool; 
            expectedStabilityPoolEthBalance += valueTransferredToStabilityPool; // StabilityPool receives this ETH
        }

        // CDP pays liquidation fee portion (liquidationFeePaidAmount) to either DFIREStaking or StabilityPool.
        // liquidationFeePaidAmount already represents the net amount transferred out for the fee (liquidationFee - refund if paid).
        expectedCdpEthBalance -= liquidationFeePaidAmount;

        const dfireStakingCollateralRewardAdded = relevantEvents.some(e => e.fragment.name === 'CollateralRewardAdded' && e.address === dfireStakingAddress);
        const stabilityPoolCollateralRewardAdded = relevantEvents.some(e => e.fragment.name === 'CollateralRewardAdded' && e.address === stabilityPoolAddress);

        if (dfireStakingCollateralRewardAdded) {
            expectedDfireStakingEthBalance += liquidationFeePaidAmount;
        } else if (stabilityPoolCollateralRewardAdded) {
            expectedStabilityPoolEthBalance += liquidationFeePaidAmount;
        }

        expect(newSnapshot.accountSnapshot[stableBaseCDPAddress] || 0n, "StableBaseCDP ETH balance mismatch").to.equal(expectedCdpEthBalance);
        expect(newSnapshot.accountSnapshot[dfireStakingAddress] || 0n, "DFIREStaking ETH balance mismatch").to.equal(expectedDfireStakingEthBalance);
        expect(newSnapshot.accountSnapshot[stabilityPoolAddress] || 0n, "StabilityPool ETH balance mismatch").to.equal(expectedStabilityPoolEthBalance);

        // Check fee distribution event emissions
        if (liquidationFeePaidAmount > 0n) { 
            expect(relevantEvents.some(e => e.fragment.name === 'LiquidationFeePaid'), "LiquidationFeePaid event not emitted").to.be.true;
        }


        // 7. Event Emissions (additional checks for required events)
        expect(relevantEvents.some(e => e.fragment.name === 'RemovedSafe'), "RemovedSafe event not emitted").to.be.true;
        expect(relevantEvents.some(e => e.fragment.name === 'Transfer' && e.args.from === prevSafeOwner && e.args.to === ethers.ZeroAddress), "ERC721 Transfer (burn) event from previous owner to address(0) not emitted").to.be.true;
        expect(relevantEvents.some(e => e.fragment.name === 'LiquidationGasCompensationPaid'), "LiquidationGasCompensationPaid event not emitted").to.be.true;
        if (safeUpdatedEventEmitted) {
            expect(relevantEvents.some(e => e.fragment.name === 'SafeUpdated'), "SafeUpdated event not emitted when expected").to.be.true;
        }

        // Protocol Mode change validation
        const prevProtocolMode = previousSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
        const newProtocolMode = newSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
        // 0 for BOOTSTRAP_MODE, 1 for NORMAL_MODE
        if (prevProtocolMode === 0 && newSnapshot.contractSnapshot.stableBaseCDP.totalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD) {
            expect(newProtocolMode, "PROTOCOL_MODE should transition from BOOTSTRAP to NORMAL").to.equal(1); 
        } else {
            expect(newProtocolMode, "PROTOCOL_MODE should not change unexpectedly").to.equal(prevProtocolMode);
        }

        return true; // All assertions passed
    }
}
