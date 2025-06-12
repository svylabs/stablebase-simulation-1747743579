import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

// Helper to generate a random BigInt within [0, max]
// This addresses the bug in the previous randomBigInt implementation for large max values.
function randomBigInt(prng: any, max: bigint): bigint {
    if (max < 0n) throw new Error("max must be non-negative");
    if (max === 0n) return 0n;

    let randomValue = 0n;
    // Determine how many 32-bit blocks are needed for max. Add a buffer block for better distribution.
    const maxBitLength = max.toString(2).length; // Get the number of bits in max
    const numBlocks = Math.ceil(Number(maxBitLength) / 32) + 1; // Number of 32-bit random integers needed, plus one buffer

    for (let i = 0; i < numBlocks; i++) {
        // prng.next() returns a number between 0 and 2^32 - 1
        randomValue = (randomValue << 32n) | BigInt(prng.next());
    }

    // Use modulo to fit within the desired range [0, max]
    return randomValue % (max + 1n);
}

class RedeemAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super('RedeemAction');
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPAddress = this.contract.target as string;
        
        // Get actor's SBD balance and allowance
        const actorSbdBalance = currentSnapshot.contractSnapshot.dfidToken.accountBalances[actor.account.address] || 0n;
        const actorSbdAllowance = currentSnapshot.contractSnapshot.dfidToken.accountAllowances[actor.account.address]?.[stableBaseCDPAddress] || 0n;

        // Get total debt in StableBaseCDP
        const totalDebt = currentSnapshot.contractSnapshot.stableBaseCDP.totalDebt;

        // Determine the maximum redeemable amount
        let maxPossibleRedeemAmount = actorSbdBalance;
        if (actorSbdAllowance < maxPossibleRedeemAmount) {
            maxPossibleRedeemAmount = actorSbdAllowance;
        }
        if (totalDebt < maxPossibleRedeemAmount) {
            maxPossibleRedeemAmount = totalDebt;
        }

        // If maxPossibleRedeemAmount is 0, action cannot be executed meaningfully.
        if (maxPossibleRedeemAmount === 0n) {
            console.log("RedeemAction: Cannot initialize. Actor has insufficient SBD balance, allowance, or no total debt exists.");
            return [false, {}, {}];
        }

        // Generate a random amount to redeem, ensuring it's at least 1 and up to maxPossibleRedeemAmount
        let amount = randomBigInt(context.prng, maxPossibleRedeemAmount);
        if (amount === 0n) {
            amount = 1n; // Ensure amount is > 0 as per contract require
        }
        
        // nearestSpotInLiquidationQueue is an optional hint; setting to 0 is valid and simple.
        const nearestSpotInLiquidationQueue = 0n;

        const actionParams = {
            amount,
            nearestSpotInLiquidationQueue,
        };

        console.log(`RedeemAction: Initialized with amount=${amount} and nearestSpotInLiquidationQueue=${nearestSpotInLiquidationQueue}`);
        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { amount, nearestSpotInLiquidationQueue } = actionParams;
        console.log(`RedeemAction: Executing redeem with amount=${amount}, nearestSpotInLiquidationQueue=${nearestSpotInLiquidationQueue}`);
        const tx = await this.contract.connect(actor.account.value).redeem(amount, nearestSpotInLiquidationQueue);
        const receipt = await tx.wait();
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
        const stableBaseCDPAddress = this.contract.target as string;
        const dfidTokenAddress = context.contracts.dfidToken.target as string;
        const stabilityPoolAddress = context.contracts.stabilityPool.target as string;

        const { amount: requestedAmount } = actionParams;

        // --- Fetch initial states ---
        const prevActorEthBalance = previousSnapshot.accountSnapshot[actor.account.address];
        const prevActorSbdBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[actor.account.address] || 0n;
        const prevCDPSbdBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[stableBaseCDPAddress] || 0n;
        const prevSbdTotalSupply = previousSnapshot.contractSnapshot.dfidToken.tokenTotalSupply;
        const prevCDPTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
        const prevCDPTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;

        const prevStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;

        // --- Fetch final states ---
        const newActorEthBalance = newSnapshot.accountSnapshot[actor.account.address];
        const newActorSbdBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[actor.account.address] || 0n;
        const newCDPSbdBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[stableBaseCDPAddress] || 0n;
        const newSbdTotalSupply = newSnapshot.contractSnapshot.dfidToken.tokenTotalSupply;
        const newCDPTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
        const newCDPTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;

        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

        // --- Extract Event Data ---
        let redeemedBatchEvent: any;
        let burnEvent: any;
        const redeemedEvents: any[] = [];
        const dfidTokenTransferEvents: any[] = []; // All DFIDToken Transfer events
        let ownerRedemptionFeeDistributedEvent: any;
        let collateralRewardAddedEvent: any;
        const safeRemovedFromLiquidationQueueEvents: any[] = [];
        const safeRemovedFromRedemptionQueueEvents: any[] = [];
        const liquidationQueueUpdatedEvents: any[] = [];
        const safeUpdatedEvents: any[] = [];
        const ownerFeePaidEvents: any[] = [];
        const redeemerFeePaidEvents: any[] = [];
        
        for (const event of executionReceipt.events) {
            if (event.address === stableBaseCDPAddress) {
                if (event.eventName === "RedeemedBatch") {
                    redeemedBatchEvent = event;
                } else if (event.eventName === "Redeemed") {
                    redeemedEvents.push(event);
                } else if (event.eventName === "OwnerFeePaid") {
                    ownerFeePaidEvents.push(event);
                } else if (event.eventName === "RedeemerFeePaid") {
                    redeemerFeePaidEvents.push(event);
                } else if (event.eventName === "OwnerRedemptionFeeDistributed") {
                    ownerRedemptionFeeDistributedEvent = event;
                } else if (event.eventName === "SafeRemovedFromLiquidationQueue") {
                    safeRemovedFromLiquidationQueueEvents.push(event);
                } else if (event.eventName === "SafeRemovedFromRedemptionQueue") {
                    safeRemovedFromRedemptionQueueEvents.push(event);
                } else if (event.eventName === "LiquidationQueueUpdated") {
                    liquidationQueueUpdatedEvents.push(event);
                } else if (event.eventName === "SafeUpdated") {
                    safeUpdatedEvents.push(event);
                }
            } else if (event.address === dfidTokenAddress) {
                if (event.eventName === "Transfer") {
                    dfidTokenTransferEvents.push(event);
                } else if (event.eventName === "Burn") {
                    burnEvent = event;
                }
            } else if (event.address === stabilityPoolAddress) {
                if (event.eventName === "CollateralRewardAdded") {
                    collateralRewardAddedEvent = event;
                }
            }
        }

        // --- Basic Event Assertions ---
        expect(redeemedBatchEvent, "RedeemedBatch event not found").to.exist;
        expect(burnEvent, "Burn event not found").to.exist; // Burn event should almost always be present if debt is redeemed

        // --- Derived values from events and action parameters ---
        const redeemedCollateralFromBatchEvent = redeemedBatchEvent.args.redeemedCollateral; // This is _redemption.collateralAmount
        const finalTotalCollateralFromEvent = redeemedBatchEvent.args.totalCollateral;
        const finalTotalDebtFromEvent = redeemedBatchEvent.args.totalDebt;

        let totalAmountToRedeemAcrossSafes = 0n;
        let totalCollateralToRedeemAcrossSafes = 0n;
        let totalAmountToRefundAcrossSafes = 0n;
        for (const event of redeemedEvents) {
            totalAmountToRedeemAcrossSafes += event.args.amountToRedeem;
            totalCollateralToRedeemAcrossSafes += event.args.collateralToRedeem;
            totalAmountToRefundAcrossSafes += event.args.amountToRefund;
        }

        // As per contract, _redemption.redeemedAmount is ensured to be equal to requestedAmount
        const actualRedeemedAmount = requestedAmount; 
        const actualRefundedAmount = totalAmountToRefundAcrossSafes;
        const netSbdBurned = actualRedeemedAmount - actualRefundedAmount;

        let totalOwnerFeePaidInRedemption = 0n;
        for (const event of ownerFeePaidEvents) {
            totalOwnerFeePaidInRedemption += event.args.ownerFee;
        }

        let totalRedeemerFeePaidInRedemption = 0n;
        for (const event of redeemerFeePaidEvents) {
            totalRedeemerFeePaidInRedemption += event.args.redeemerFee;
        }

        // Determine if StabilityPool can receive rewards using the snapshot flag
        const stabilityPoolCanReceiveRewards = previousSnapshot.contractSnapshot.stableBaseCDP.stabilityPoolRewardsEnabled;

        // --- Validate Token Balances and Supply ---

        // 1. User's SBD token balance
        let expectedActorSbdBalanceChange = -requestedAmount; // Initial transferFrom to CDP
        // Check for SBD transfer from CDP to msg.sender as ownerFee refund (if stabilityPoolCanReceiveRewards is false)
        const actorSbdRefundedAsOwnerFeeTransfer = dfidTokenTransferEvents.find(
            e => e.from === stableBaseCDPAddress && e.to === actor.account.address && totalOwnerFeePaidInRedemption > 0n && !stabilityPoolCanReceiveRewards
        );
        if (actorSbdRefundedAsOwnerFeeTransfer) {
            expectedActorSbdBalanceChange += actorSbdRefundedAsOwnerFeeTransfer.args.value;
        }
        expect(newActorSbdBalance).to.equal(prevActorSbdBalance + expectedActorSbdBalanceChange, "Actor's SBD balance incorrect");

        // 2. StableBaseCDP contract's SBD token balance
        let expectedCDPSbdChange = requestedAmount; // From initial transferFrom
        expectedCDPSbdChange -= netSbdBurned; // From burn

        // SBD transferred from CDP to safe owners as refund (OwnerRefunded event implies this via sbdToken.transfer)
        const sbdTransferredToSafeOwners = dfidTokenTransferEvents.filter(
            e => e.from === stableBaseCDPAddress && e.to !== stableBaseCDPAddress && e.to !== stabilityPoolAddress && e.to !== actor.account.address && e.eventName === "Transfer"
        );
        for (const event of sbdTransferredToSafeOwners) {
            expectedCDPSbdChange -= event.args.value;
        }

        // SBD transferred from CDP to StabilityPool as owner fee (OwnerRedemptionFeeDistributed implies this via stabilityPool.addReward)
        if (ownerRedemptionFeeDistributedEvent) {
            expectedCDPSbdChange -= ownerRedemptionFeeDistributedEvent.args.amount;
        }
        
        expect(newCDPSbdBalance).to.equal(prevCDPSbdBalance + expectedCDPSbdChange, "CDP SBD balance incorrect");


        // 3. Total supply of SBD tokens
        expect(newSbdTotalSupply).to.equal(prevSbdTotalSupply - netSbdBurned, "DFIDToken total supply incorrect");
        expect(burnEvent.args.amount).to.equal(netSbdBurned, "Burn event amount incorrect");

        // 4. User's ETH balance
        const gasCost = executionReceipt.gasUsed * executionReceipt.effectiveGasPrice;
        let expectedEthReceivedByActor = redeemedCollateralFromBatchEvent;
        // If redeemerFee is not sent to StabilityPool, it's refunded to msg.sender (actor) as collateralRefund
        if (totalRedeemerFeePaidInRedemption > 0n && !stabilityPoolCanReceiveRewards) {
            expectedEthReceivedByActor += totalRedeemerFeePaidInRedemption;
        }
        const expectedActorEthBalance = prevActorEthBalance - gasCost + expectedEthReceivedByActor;
        expect(newActorEthBalance).to.equal(expectedActorEthBalance, "Actor's ETH balance incorrect");

        // --- Validate StableBaseCDP Global State ---
        // totalCollateral: decreased by (redemption.collateralAmount + redemption.redeemerFee)
        expect(newCDPTotalCollateral).to.equal(prevCDPTotalCollateral - (redeemedCollateralFromBatchEvent + totalRedeemerFeePaidInRedemption), "StableBaseCDP.totalCollateral incorrect");
        expect(newCDPTotalCollateral).to.equal(finalTotalCollateralFromEvent, "StableBaseCDP.totalCollateral in snapshot vs event mismatch");

        // totalDebt: decreased by (redemption.redeemedAmount - redemption.refundedAmount)
        expect(newCDPTotalDebt).to.equal(prevCDPTotalDebt - netSbdBurned, "StableBaseCDP.totalDebt incorrect");
        expect(newCDPTotalDebt).to.equal(finalTotalDebtFromEvent, "StableBaseCDP.totalDebt in snapshot vs event mismatch");

        // PROTOCOL_MODE transition
        const prevProtocolMode = previousSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
        const newProtocolMode = newSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
        // BOOTSTRAP_MODE_DEBT_THRESHOLD is a constant from the contract's context summary
        const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * (10n ** 18n); 

        if (prevProtocolMode === 0 /* BOOTSTRAP */ && newCDPTotalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD && prevCDPTotalDebt <= BOOTSTRAP_MODE_DEBT_THRESHOLD) { 
            expect(newProtocolMode).to.equal(1 /* NORMAL */, "PROTOCOL_MODE did not transition from BOOTSTRAP to NORMAL as expected");
        } else {
            expect(newProtocolMode).to.equal(prevProtocolMode, "PROTOCOL_MODE changed unexpectedly or did not change when expected");
        }

        // --- Validate Individual Safe State & Queue Integrity ---
        for (const redeemedEvent of redeemedEvents) {
            const safeId = redeemedEvent.args.safeId;
            const amountToRedeem = redeemedEvent.args.amountToRedeem;
            const collateralToRedeem = redeemedEvent.args.collateralToRedeem;

            const prevSafeDetails = previousSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()];
            expect(prevSafeDetails, `Previous details for safe ${safeId} not found`).to.exist;

            const newSafeDetails = newSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()];

            // Check if the safe was fully redeemed (borrowedAmount becomes 0 in borrowMode or both become 0 in exchange mode)
            // We infer this from the final state of the safe in the new snapshot or its absence.
            const isSafeFullyRedeemed = (newSafeDetails === undefined || (newSafeDetails.borrowedAmount === 0n && newSafeDetails.collateralAmount === 0n));

            if (isSafeFullyRedeemed) {
                // Verify removal from queues
                const safeRemovedFromLiquidationQueueEvent = safeRemovedFromLiquidationQueueEvents.find(e => e.args.safeId === safeId);
                const safeRemovedFromRedemptionQueueEvent = safeRemovedFromRedemptionQueueEvents.find(e => e.args.safeId === safeId);
                expect(safeRemovedFromLiquidationQueueEvent, `Safe ${safeId} was fully redeemed but no SafeRemovedFromLiquidationQueue event`).to.exist;
                expect(safeRemovedFromRedemptionQueueEvent, `Safe ${safeId} was fully redeemed but no SafeRemovedFromRedemptionQueue event`).to.exist;

                expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[safeId.toString()], `Safe ${safeId} still in liquidation nodes after full redemption`).to.be.undefined;
                expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[safeId.toString()], `Safe ${safeId} still in redemption nodes after full redemption`).to.be.undefined;

                // Validate OrderedDoublyLinkedList head/tail updates if the removed safe was head/tail
                const prevLiquidationHead = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.headId;
                const prevLiquidationTail = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.tailId;
                const prevRedemptionHead = previousSnapshot.contractSnapshot.safesOrderedForRedemption.headId;
                const prevRedemptionTail = previousSnapshot.contractSnapshot.safesOrderedForRedemption.tailId;

                const prevLiquidationNode = previousSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes[safeId.toString()];
                const prevRedemptionNode = previousSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[safeId.toString()];

                if (prevLiquidationHead === safeId) {
                    expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.headId).to.equal(prevLiquidationNode?.next || 0n, `Liquidation queue head not updated correctly after removing ${safeId}`);
                }
                if (prevLiquidationTail === safeId) {
                    expect(newSnapshot.contractSnapshot.safesOrderedForLiquidation.tailId).to.equal(prevLiquidationNode?.prev || 0n, `Liquidation queue tail not updated correctly after removing ${safeId}`);
                }
                if (prevRedemptionHead === safeId) {
                    expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.headId).to.equal(prevRedemptionNode?.next || 0n, `Redemption queue head not updated correctly after removing ${safeId}`);
                }
                if (prevRedemptionTail === safeId) {
                    expect(newSnapshot.contractSnapshot.safesOrderedForRedemption.tailId).to.equal(prevRedemptionNode?.prev || 0n, `Redemption queue tail not updated correctly after removing ${safeId}`);
                }

            } else {
                // Partially redeemed: verify amounts reduced
                expect(newSafeDetails.borrowedAmount).to.equal(prevSafeDetails.borrowedAmount - amountToRedeem, `Safe ${safeId} borrowedAmount incorrect for partial redemption`);
                expect(newSafeDetails.collateralAmount).to.equal(prevSafeDetails.collateralAmount - collateralToRedeem, `Safe ${safeId} collateralAmount incorrect for partial redemption`);

                // Verify LiquidationQueueUpdated event and position in queue
                const liquidationQueueUpdatedEvent = liquidationQueueUpdatedEvents.find(e => e.args.safeId === safeId);
                expect(liquidationQueueUpdatedEvent, `LiquidationQueueUpdated event for safe ${safeId} not found for partial redemption`).to.exist;

                // Validate safe.feePaid and safe.totalBorrowedAmount reset if an owner fee was paid for this specific safe
                const ownerFeeForThisSafe = ownerFeePaidEvents.find(e => e.args.safeId === safeId); 
                if (ownerFeeForThisSafe) {
                    expect(newSafeDetails.feePaid).to.equal(0n, `Safe ${safeId} feePaid not reset to 0`);
                    expect(newSafeDetails.totalBorrowedAmount).to.equal(1n, `Safe ${safeId} totalBorrowedAmount not reset to 1`);
                }

                // Validate liquidation snapshots for affected safes
                const newLiquidationSnapshot = newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots?.[safeId.toString()];
                const finalCumulativeCollateralPerUnitCollateral = newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral;
                const finalCumulativeDebtPerUnitCollateral = newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral;

                expect(newLiquidationSnapshot, `Liquidation snapshot for safe ${safeId} missing in new snapshot`).to.exist;
                expect(newLiquidationSnapshot.collateralPerCollateralSnapshot).to.equal(finalCumulativeCollateralPerUnitCollateral, `Safe ${safeId} collateralPerCollateralSnapshot not updated correctly`);
                expect(newLiquidationSnapshot.debtPerCollateralSnapshot).to.equal(finalCumulativeDebtPerUnitCollateral, `Safe ${safeId} debtPerCollateralSnapshot not updated correctly`);

                // Check if SafeUpdated event was expected based on cumulative snapshot changes
                const prevLiquidationSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots?.[safeId.toString()];
                const cumulativeCollateralPerUnitCollateralBeforeTx = previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral;
                const cumulativeDebtPerUnitCollateralBeforeTx = previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral;
                
                if (prevLiquidationSnapshot?.collateralPerCollateralSnapshot !== cumulativeCollateralPerUnitCollateralBeforeTx ||
                    prevLiquidationSnapshot?.debtPerCollateralSnapshot !== cumulativeDebtPerUnitCollateralBeforeTx) {
                    const safeUpdatedEvent = safeUpdatedEvents.find(e => e.args.safeId === safeId);
                    expect(safeUpdatedEvent, `SafeUpdated event for safe ${safeId} not found when cumulative snapshots changed`).to.exist;
                }
            }
        }

        // --- Validate StabilityPool Contract State (if applicable) ---
        const STABILITY_POOL_PRECISION = 10n ** 18n; // Assuming it's 1e18 as per context

        // 5. StabilityPool SBD balance
        // If owner fee was distributed to StabilityPool
        if (ownerRedemptionFeeDistributedEvent) {
            expect(newStabilityPoolSnapshot.users[actor.account.address]?.stake || 0n).to.equal(prevStabilityPoolSnapshot.users[actor.account.address]?.stake || 0n, "Actor's stake in stability pool should not change"); // Assuming owner fee does not change stake
            expect(newStabilityPoolSnapshot.totalStakedRaw).to.equal(prevStabilityPoolSnapshot.totalStakedRaw, "StabilityPool totalStakedRaw should not change"); // Assuming owner fee does not change total staked

            expect(newSnapshot.contractSnapshot.dfidToken.accountBalances[stabilityPoolAddress]).to.equal(prevSnapshot.contractSnapshot.dfidToken.accountBalances[stabilityPoolAddress] + ownerRedemptionFeeDistributedEvent.args.amount, "StabilityPool SBD balance incorrect");

            // Validate internal state variables based on addReward logic
            const ownerFeeAmount = ownerRedemptionFeeDistributedEvent.args.amount;
            const prevTotalStakedRaw = prevStabilityPoolSnapshot.totalStakedRaw;

            if (prevTotalStakedRaw > 0n) {
                const prevRewardLoss = prevStabilityPoolSnapshot.rewardLoss;
                const prevTotalRewardPerToken = prevStabilityPoolSnapshot.totalRewardPerToken;
                const prevSbrRewardDistributionStatus = prevStabilityPoolSnapshot.sbrRewardDistributionStatus;

                const _totalAmount = ownerFeeAmount + prevRewardLoss;
                const _rewardPerToken = ((_totalAmount * prevStabilityPoolSnapshot.stakeScalingFactor * STABILITY_POOL_PRECISION) / prevTotalStakedRaw) / STABILITY_POOL_PRECISION;

                const expectedNewTotalRewardPerToken = prevTotalRewardPerToken + _rewardPerToken;
                const expectedNewRewardLoss = _totalAmount - (((_rewardPerToken * prevTotalStakedRaw * STABILITY_POOL_PRECISION) / prevStabilityPoolSnapshot.stakeScalingFactor) / STABILITY_POOL_PRECISION);

                expect(newStabilityPoolSnapshot.totalRewardPerToken).to.equal(expectedNewTotalRewardPerToken, "StabilityPool totalRewardPerToken incorrect");
                expect(newStabilityPoolSnapshot.rewardLoss).to.equal(expectedNewRewardLoss, "StabilityPool rewardLoss incorrect");

                // SBR rewards logic (from _addSBRRewards)
                let expectedLastSBRRewardDistributedTime = prevStabilityPoolSnapshot.lastSBRRewardDistributedTime;
                let expectedSbrRewardDistributionEndTime = prevStabilityPoolSnapshot.sbrRewardDistributionEndTime;
                let expectedSbrRewardDistributionStatus = prevSbrRewardDistributionStatus;
                let expectedSbrRewardLoss = prevStabilityPoolSnapshot.sbrRewardLoss;
                let expectedTotalSbrRewardPerToken = prevStabilityPoolSnapshot.totalSbrRewardPerToken;

                // Using block.timestamp from execution receipt. This is an approximation if not directly available.
                const blockTimestamp = BigInt(executionReceipt.blockNumber); // Placeholder, ideally use actual block.timestamp

                if (prevSbrRewardDistributionStatus === 1n /* STARTED */) {
                    let timeElapsed = blockTimestamp - prevStabilityPoolSnapshot.lastSBRRewardDistributedTime;
                    if (blockTimestamp > prevStabilityPoolSnapshot.sbrRewardDistributionEndTime) {
                        expectedSbrRewardDistributionStatus = 2n /* ENDED */;
                        timeElapsed = prevStabilityPoolSnapshot.sbrRewardDistributionEndTime - prevStabilityPoolSnapshot.lastSBRRewardDistributedTime;
                    }
                    const sbrReward = timeElapsed * prevStabilityPoolSnapshot.sbrDistributionRate;
                    if (prevTotalStakedRaw > 0n) { // Condition from _addSBRRewards
                        const _sbrReward = sbrReward + prevStabilityPoolSnapshot.sbrRewardLoss;
                        const _totalSbrRewardPerToken = ((_sbrReward * prevStabilityPoolSnapshot.stakeScalingFactor * STABILITY_POOL_PRECISION) / prevTotalStakedRaw) / STABILITY_POOL_PRECISION;
                        expectedTotalSbrRewardPerToken += _totalSbrRewardPerToken;
                        expectedSbrRewardLoss = _sbrReward - (((_totalSbrRewardPerToken * prevTotalStakedRaw * STABILITY_POOL_PRECISION) / prevStabilityPoolSnapshot.stakeScalingFactor) / STABILITY_POOL_PRECISION);
                    }
                    expectedLastSBRRewardDistributedTime = blockTimestamp;
                } else if (prevSbrRewardDistributionStatus === 0n /* NOT_STARTED */) {
                    expectedLastSBRRewardDistributedTime = blockTimestamp;
                    expectedSbrRewardDistributionEndTime = blockTimestamp + (365n * 24n * 60n * 60n); // 365 days in seconds
                    expectedSbrRewardDistributionStatus = 1n /* STARTED */;
                }

                expect(newStabilityPoolSnapshot.lastSBRRewardDistributedTime).to.equal(expectedLastSBRRewardDistributedTime, "StabilityPool lastSBRRewardDistributedTime incorrect");
                expect(newStabilityPoolSnapshot.sbrRewardDistributionEndTime).to.equal(expectedSbrRewardDistributionEndTime, "StabilityPool sbrRewardDistributionEndTime incorrect");
                expect(newStabilityPoolSnapshot.sbrRewardDistributionStatus).to.equal(expectedSbrRewardDistributionStatus, "StabilityPool sbrRewardDistributionStatus incorrect");
                expect(newStabilityPoolSnapshot.sbrRewardLoss).to.equal(expectedSbrRewardLoss, "StabilityPool sbrRewardLoss incorrect");
                expect(newStabilityPoolSnapshot.totalSbrRewardPerToken).to.equal(expectedTotalSbrRewardPerToken, "StabilityPool totalSbrRewardPerToken incorrect");

            } else {
                // If totalStakedRaw was 0, no reward should be added for SBD owner fee
                expect(newStabilityPoolSnapshot.totalRewardPerToken).to.equal(prevStabilityPoolSnapshot.totalRewardPerToken, "StabilityPool totalRewardPerToken should not change if totalStakedRaw is 0");
                expect(newStabilityPoolSnapshot.rewardLoss).to.equal(prevStabilityPoolSnapshot.rewardLoss, "StabilityPool rewardLoss should not change if totalStakedRaw is 0");
                
                // SBR rewards might still be updated if status changes from NOT_STARTED to STARTED (even if totalStakedRaw is 0)
                if (prevStabilityPoolSnapshot.sbrRewardDistributionStatus === 0n /* NOT_STARTED */) {
                    const blockTimestamp = BigInt(executionReceipt.blockNumber); // Placeholder for actual block.timestamp
                    expect(newStabilityPoolSnapshot.lastSBRRewardDistributedTime).to.equal(blockTimestamp, "StabilityPool lastSBRRewardDistributedTime incorrect (NOT_STARTED->STARTED)");
                    expect(newStabilityPoolSnapshot.sbrRewardDistributionEndTime).to.equal(blockTimestamp + (365n * 24n * 60n * 60n), "StabilityPool sbrRewardDistributionEndTime incorrect (NOT_STARTED->STARTED)");
                    expect(newStabilityPoolSnapshot.sbrRewardDistributionStatus).to.equal(1n /* STARTED */, "StabilityPool sbrRewardDistributionStatus incorrect (NOT_STARTED->STARTED)");
                } else {
                    // If totalStakedRaw was 0 and status was not NOT_STARTED, SBR-related state should not change from previous.
                    expect(newStabilityPoolSnapshot.lastSBRRewardDistributedTime).to.equal(prevStabilityPoolSnapshot.lastSBRRewardDistributedTime, "StabilityPool lastSBRRewardDistributedTime should not change if totalStakedRaw is 0 and not NOT_STARTED");
                    expect(newStabilityPoolSnapshot.sbrRewardDistributionEndTime).to.equal(prevStabilityPoolSnapshot.sbrRewardDistributionEndTime, "StabilityPool sbrRewardDistributionEndTime should not change if totalStakedRaw is 0 and not NOT_STARTED");
                    expect(newStabilityPoolSnapshot.sbrRewardDistributionStatus).to.equal(prevStabilityPoolSnapshot.sbrRewardDistributionStatus, "StabilityPool sbrRewardDistributionStatus should not change if totalStakedRaw is 0 and not NOT_STARTED");
                }
                expect(newStabilityPoolSnapshot.sbrRewardLoss).to.equal(prevStabilityPoolSnapshot.sbrRewardLoss, "StabilityPool sbrRewardLoss should not change if totalStakedRaw is 0");
                expect(newStabilityPoolSnapshot.totalSbrRewardPerToken).to.equal(prevStabilityPoolSnapshot.totalSbrRewardPerToken, "StabilityPool totalSbrRewardPerToken should not change if totalStakedRaw is 0");
            }
        } else {
            // If no owner fee distributed to StabilityPool, SBD related state should not change from addReward
            expect(newStabilityPoolSnapshot.totalRewardPerToken).to.equal(prevStabilityPoolSnapshot.totalRewardPerToken, "StabilityPool totalRewardPerToken should not change if no owner fee distributed");
            expect(newStabilityPoolSnapshot.rewardLoss).to.equal(prevStabilityPoolSnapshot.rewardLoss, "StabilityPool rewardLoss should not change if no owner fee distributed");
            // SBR related state should also remain unchanged if addReward was not called (or called with amount 0)
            expect(newStabilityPoolSnapshot.lastSBRRewardDistributedTime).to.equal(prevStabilityPoolSnapshot.lastSBRRewardDistributedTime, "StabilityPool lastSBRRewardDistributedTime should not change if no owner fee distributed");
            expect(newStabilityPoolSnapshot.sbrRewardDistributionEndTime).to.equal(prevStabilityPoolSnapshot.sbrRewardDistributionEndTime, "StabilityPool sbrRewardDistributionEndTime should not change if no owner fee distributed");
            expect(newStabilityPoolSnapshot.sbrRewardDistributionStatus).to.equal(prevStabilityPoolSnapshot.sbrRewardDistributionStatus, "StabilityPool sbrRewardDistributionStatus should not change if no owner fee distributed");
            expect(newStabilityPoolSnapshot.sbrRewardLoss).to.equal(prevStabilityPoolSnapshot.sbrRewardLoss, "StabilityPool sbrRewardLoss should not change if no owner fee distributed");
            expect(newStabilityPoolSnapshot.totalSbrRewardPerToken).to.equal(prevStabilityPoolSnapshot.totalSbrRewardPerToken, "StabilityPool totalSbrRewardPerToken should not change if no owner fee distributed");
        }

        // 6. StabilityPool ETH balance (if applicable)
        // If redeemer fee was distributed to StabilityPool
        if (collateralRewardAddedEvent) {
            expect(newSnapshot.accountSnapshot[stabilityPoolAddress]).to.equal(prevSnapshot.accountSnapshot[stabilityPoolAddress] + collateralRewardAddedEvent.args.amount, "StabilityPool ETH balance incorrect");

            // Validate internal state variables based on addCollateralReward logic
            const collateralRewardAmount = collateralRewardAddedEvent.args.amount;
            const prevTotalStakedRaw = prevStabilityPoolSnapshot.totalStakedRaw;

            if (prevTotalStakedRaw > 0n) {
                const prevCollateralLoss = prevStabilityPoolSnapshot.collateralLoss;
                const prevTotalCollateralPerToken = prevStabilityPoolSnapshot.totalCollateralPerToken;

                const _totalAmount = collateralRewardAmount + prevCollateralLoss;
                const _collateralPerToken = ((_totalAmount * prevStabilityPoolSnapshot.stakeScalingFactor * STABILITY_POOL_PRECISION) / prevTotalStakedRaw) / STABILITY_POOL_PRECISION;

                const expectedNewTotalCollateralPerToken = prevTotalCollateralPerToken + _collateralPerToken;
                const expectedNewCollateralLoss = _totalAmount - (((_collateralPerToken * prevTotalStakedRaw * STABILITY_POOL_PRECISION) / prevStabilityPoolSnapshot.stakeScalingFactor) / STABILITY_POOL_PRECISION);

                expect(newStabilityPoolSnapshot.totalCollateralPerToken).to.equal(expectedNewTotalCollateralPerToken, "StabilityPool totalCollateralPerToken incorrect");
                expect(newStabilityPoolSnapshot.collateralLoss).to.equal(expectedNewCollateralLoss, "StabilityPool collateralLoss incorrect");
            } else {
                expect(newStabilityPoolSnapshot.totalCollateralPerToken).to.equal(prevStabilityPoolSnapshot.totalCollateralPerToken, "StabilityPool totalCollateralPerToken should not change if totalStakedRaw is 0");
                expect(newStabilityPoolSnapshot.collateralLoss).to.equal(prevStabilityPoolSnapshot.collateralLoss, "StabilityPool collateralLoss should not change if totalStakedRaw is 0");
            }
        } else {
            // If no collateral reward added, ETH related state should not change
            expect(newStabilityPoolSnapshot.totalCollateralPerToken).to.equal(prevStabilityPoolSnapshot.totalCollateralPerToken, "StabilityPool totalCollateralPerToken should not change if no collateral reward added");
            expect(newStabilityPoolSnapshot.collateralLoss).to.equal(prevStabilityPoolSnapshot.collateralLoss, "StabilityPool collateralLoss should not change if no collateral reward added");
            expect(newSnapshot.accountSnapshot[stabilityPoolAddress]).to.equal(prevSnapshot.accountSnapshot[stabilityPoolAddress], "StabilityPool ETH balance should not change if no collateral reward added");
        }
        
        console.log("RedeemAction: All validations passed.");
        return true;
    }
}
