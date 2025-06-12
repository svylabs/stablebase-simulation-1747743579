import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from 'chai';
import {ethers} from 'ethers';

// Constants from the contract context
const BASIS_POINTS_DIVISOR = 10000n;
const PRECISION = 10n ** 18n;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * 10n ** 18n;

class FeetopupAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("FeetopupAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPContract = context.contracts.stableBaseCDP;
        const dfidTokenContract = context.contracts.dfidToken;

        const actorAddress = actor.account.address;
        const safes = currentSnapshot.contractSnapshot.stableBaseCDP.safeOwner;

        // Find a safe owned by the actor
        let safeId: bigint | undefined;
        for (const id in safes) {
            if (safes[id] === actorAddress) {
                safeId = BigInt(id);
                break;
            }
        }

        if (safeId === undefined) {
            // No CDP owned by the actor
            return [false, {}, {}];
        }

        const safeDetails = currentSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()];
        if (!safeDetails) {
            // Safe details not found for the identified safeId, shouldn't happen if safeOwner mapping is correct
            return [false, {}, {}];
        }

        // The 'borrowedAmount' must be > 0 for fee calculation to be meaningful in terms of a non-zero fee.
        // If borrowedAmount is 0, the calculated fee will be 0. The action's purpose is fee topup.
        // For this action to be relevant, we assume a non-zero borrowedAmount.
        if (safeDetails.borrowedAmount === 0n) {
            return [false, {}, {}];
        }

        // Generate a positive topupRate. Let's use a range between 1 and 10000 basis points.
        const topupRate = context.prng.nextBigInt(1n, 10000n);

        const calculatedFee = (topupRate * safeDetails.borrowedAmount) / BASIS_POINTS_DIVISOR;

        // Check if sender has enough SBD tokens to cover the fee
        const actorSbdBalance = currentSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress] || 0n;
        if (actorSbdBalance < calculatedFee) {
            // Insufficient SBD balance to pay the fee
            return [false, {}, {}];
        }

        // nearestSpotInRedemptionQueue can be 0 or an existing node ID.
        // For better test coverage, we can randomly choose between 0 and an existing node if available.
        let nearestSpotInRedemptionQueue = 0n;
        const redemptionNodes = currentSnapshot.contractSnapshot.safesOrderedForRedemption.nodes;
        const nodeIds = Object.keys(redemptionNodes).map(BigInt);
        if (nodeIds.length > 0 && context.prng.next() < 0.5) { // 50% chance to pick an existing node
            nearestSpotInRedemptionQueue = nodeIds[Number(context.prng.nextBigInt(0n, BigInt(nodeIds.length - 1)))];
        }


        const actionParams = {
            safeId,
            topupRate,
            nearestSpotInRedemptionQueue
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value as ethers.Signer;
        const contractWithSigner = this.contract.connect(signer);

        const tx = await contractWithSigner.feeTopup(
            actionParams.safeId,
            actionParams.topupRate,
            actionParams.nearestSpotInRedemptionQueue
        );
        const receipt = await tx.wait();
        if (!receipt) {
            throw new Error("Transaction receipt is null");
        }
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
        const { safeId, topupRate, nearestSpotInRedemptionQueue } = actionParams;
        const actorAddress = actor.account.address;
        const stableBaseCDPAddress = context.contracts.stableBaseCDP.target;
        const dfidTokenAddress = context.contracts.dfidToken.target;
        const dfireStakingAddress = context.contracts.dfireStaking.target;
        const stabilityPoolAddress = context.contracts.stabilityPool.target;

        let validationPassed = true;

        // 1. Event Validation
        const events = executionReceipt.logs.map(log => {
            try {
                return this.contract.interface.parseLog(log as any);
            } catch (e) {
                // If it's not an event from this contract, try other known contracts
                try {
                    const dfidTokenContract = context.contracts.dfidToken;
                    return dfidTokenContract.interface.parseLog(log as any);
                } catch (e) {
                    try {
                        const dfireStakingContract = context.contracts.dfireStaking;
                        return dfireStakingContract.interface.parseLog(log as any);
                    } catch (e) {
                        try {
                            const stabilityPoolContract = context.contracts.stabilityPool;
                            return stabilityPoolContract.interface.parseLog(log as any);
                        } catch (e) {
                            return null;
                        }
                    }
                }
            }
        }).filter(e => e !== null);

        // Required Events
        const feeTopupEvent = events.find(e => e?.name === "FeeTopup");
        const safeUpdatedEvent = events.find(e => e?.name === "SafeUpdated");
        const redemptionQueueUpdatedEvent = events.find(e => e?.name === "RedemptionQueueUpdated");
        const feeDistributedEvent = events.find(e => e?.name === "FeeDistributed");
        const sbdTransferFromEvent = events.find(e => e?.name === "Transfer" && e?.args[0].toLowerCase() === actorAddress.toLowerCase() && e?.args[1].toLowerCase() === stableBaseCDPAddress.toLowerCase());

        try {
            expect(feeTopupEvent, "FeeTopup event must be emitted").to.not.be.null;
            expect(safeUpdatedEvent, "SafeUpdated event must be emitted").to.not.be.null;
            expect(redemptionQueueUpdatedEvent, "RedemptionQueueUpdated event must be emitted").to.not.be.null;
            expect(feeDistributedEvent, "FeeDistributed event must be emitted").to.not.be.null;
            expect(sbdTransferFromEvent, "SBD Transfer (from sender to CDP) event must be emitted").to.not.be.null;
        } catch (e: any) {
            console.error("Event validation failed: ", e.message);
            validationPassed = false;
        }

        if (!validationPassed) return false;

        const feeFromEvent = feeTopupEvent!.args.feePaid as bigint;
        const newWeightFromEvent = feeTopupEvent!.args.newWeight as bigint;
        const collateralIncreaseFromEvent = safeUpdatedEvent!.args.collateralIncrease as bigint;
        const debtIncreaseFromEvent = safeUpdatedEvent!.args.debtIncrease as bigint;
        const sbrStakersFeeFromEvent = feeDistributedEvent!.args.sbrStakersFee as bigint;
        const stabilityPoolFeeFromEvent = feeDistributedEvent!.args.stabilityPoolFee as bigint;
        const canRefundFromEvent = feeDistributedEvent!.args.canRefund as bigint;

        const feeRefundEvent = events.find(e => e?.name === "FeeRefund");
        let refundAmountFromEvent = 0n;
        if (feeRefundEvent) {
            refundAmountFromEvent = feeRefundEvent.args.amount as bigint;
            try {
                expect(refundAmountFromEvent, "FeeRefund amount mismatch with canRefund").to.equal(canRefundFromEvent);
            } catch (e: any) {
                console.error("FeeRefund event validation failed: ", e.message);
                validationPassed = false;
            }
        }
        
        const sbdTransferToSenderEvent = events.find(e => e?.name === "Transfer" && e?.args[0].toLowerCase() === stableBaseCDPAddress.toLowerCase() && e?.args[1].toLowerCase() === actorAddress.toLowerCase());
        if (refundAmountFromEvent > 0n) {
             try {
                expect(sbdTransferToSenderEvent, "SBD Transfer (from CDP to sender) event must be emitted if refund > 0").to.not.be.null;
                expect(sbdTransferToSenderEvent!.args.value, "SBD refund transfer amount mismatch").to.equal(refundAmountFromEvent);
            } catch (e: any) {
                console.error("SBD refund transfer event validation failed: ", e.message);
                validationPassed = false;
            }
        }

        const rewardAddedDFIREStakingEvent = events.find(e => e?.name === "RewardAdded" && (e?.log?.address.toLowerCase() === dfireStakingAddress.toLowerCase()));
        const rewardAddedStabilityPoolEvent = events.find(e => e?.name === "RewardAdded" && (e?.log?.address.toLowerCase() === stabilityPoolAddress.toLowerCase()));
        const sbrRewardsAddedEvent = events.find(e => e?.name === "SBRRewardsAdded" && (e?.log?.address.toLowerCase() === stabilityPoolAddress.toLowerCase()));

        // 2. StableBaseCDP Contract State Validation
        const previousSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()];
        const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()];
        const previousLiquidationSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId.toString()];
        const newLiquidationSnapshot = newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId.toString()];

        try {
            // weight and feePaid
            expect(newSafe.weight, "Safe weight not updated correctly").to.equal(previousSafe.weight + topupRate);
            expect(newSafe.feePaid, "Safe feePaid not updated correctly").to.equal(previousSafe.feePaid + feeFromEvent);

            // _updateSafe related validations: Check if _updateSafe was triggered by comparing snapshots
            const prevCumulativeCollateralPerUnitCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral;
            const newCumulativeCollateralPerUnitCollateral = newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral;
            const newCumulativeDebtPerUnitCollateral = newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral;

            if (previousLiquidationSnapshot.collateralPerCollateralSnapshot !== newCumulativeCollateralPerUnitCollateral) {
                // _updateSafe was triggered - validate changes using values from SafeUpdated event
                expect(newSafe.borrowedAmount, "Safe borrowedAmount not updated correctly after _updateSafe").to.equal(previousSafe.borrowedAmount + debtIncreaseFromEvent);
                expect(newSafe.collateralAmount, "Safe collateralAmount not updated correctly after _updateSafe").to.equal(previousSafe.collateralAmount + collateralIncreaseFromEvent);
                expect(newLiquidationSnapshot.debtPerCollateralSnapshot, "liquidationSnapshot.debtPerCollateralSnapshot not updated").to.equal(newCumulativeDebtPerCollateral);
                expect(newLiquidationSnapshot.collateralPerCollateralSnapshot, "liquidationSnapshot.collateralPerCollateralSnapshot not updated").to.equal(newCumulativeCollateralPerUnitCollateral);
                expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral, "totalCollateral not updated").to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral + collateralIncreaseFromEvent);
                expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebt, "totalDebt not updated").to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt + debtIncreaseFromEvent);
            } else {
                // _updateSafe was NOT triggered - values should remain unchanged
                expect(newSafe.borrowedAmount, "Safe borrowedAmount should not change").to.equal(previousSafe.borrowedAmount);
                expect(newSafe.collateralAmount, "Safe collateralAmount should not change").to.equal(previousSafe.collateralAmount);
                expect(newLiquidationSnapshot.debtPerCollateralSnapshot, "liquidationSnapshot.debtPerCollateralSnapshot should not change").to.equal(previousLiquidationSnapshot.debtPerCollateralSnapshot);
                expect(newLiquidationSnapshot.collateralPerCollateralSnapshot, "liquidationSnapshot.collateralPerCollateralSnapshot should not change").to.equal(previousLiquidationSnapshot.collateralPerCollateralSnapshot);
                expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral, "totalCollateral should not change").to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral);
                expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebt, "totalDebt should not change").to.equal(previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt);
            }

            // PROTOCOL_MODE validation
            const prevTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
            const prevProtocolMode = previousSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
            const newProtocolMode = newSnapshot.contractSnapshot.stableBaseCDP.protocolMode;

            // Mode transitions from BOOTSTRAP (0) to NORMAL (1) if totalDebt exceeds threshold
            if (prevProtocolMode === 0 && newSnapshot.contractSnapshot.stableBaseCDP.totalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD) {
                expect(newProtocolMode, "PROTOCOL_MODE should transition to NORMAL").to.equal(1);
            } else {
                expect(newProtocolMode, "PROTOCOL_MODE should not change").to.equal(prevProtocolMode);
            }

        } catch (e: any) {
            console.error("StableBaseCDP state validation failed: ", e.message);
            validationPassed = false;
        }


        // 3. DFIDToken (SBD) Contract State Validation
        const prevActorSbdBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress] || 0n;
        const newActorSbdBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress] || 0n;
        const prevCdpSbdBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[stableBaseCDPAddress] || 0n;
        const newCdpSbdBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[stableBaseCDPAddress] || 0n;
        const prevDfireStakingSbdBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[dfireStakingAddress] || 0n;
        const newDfireStakingSbdBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[dfireStakingAddress] || 0n;
        const prevStabilityPoolSbdBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[stabilityPoolAddress] || 0n;
        const newStabilityPoolSbdBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[stabilityPoolAddress] || 0n;

        try {
            expect(newActorSbdBalance, "Actor SBD balance incorrect").to.equal(prevActorSbdBalance - feeFromEvent + refundAmountFromEvent);
            expect(newCdpSbdBalance, "StableBaseCDP SBD balance incorrect").to.equal(prevCdpSbdBalance + feeFromEvent - refundAmountFromEvent);

            // DFIREStaking SBD balance update is conditional on addReward success (implied by RewardAdded event)
            if (sbrStakersFeeFromEvent > 0n && rewardAddedDFIREStakingEvent) {
                expect(newDfireStakingSbdBalance, "DFIREStaking SBD balance incorrect").to.equal(prevDfireStakingSbdBalance + sbrStakersFeeFromEvent);
            } else {
                 expect(newDfireStakingSbdBalance, "DFIREStaking SBD balance should not change").to.equal(prevDfireStakingSbdBalance);
            }

            // StabilityPool SBD balance update is conditional on addReward success (implied by RewardAdded event)
            if (stabilityPoolFeeFromEvent > 0n && rewardAddedStabilityPoolEvent) {
                expect(newStabilityPoolSbdBalance, "StabilityPool SBD balance incorrect").to.equal(prevStabilityPoolSbdBalance + stabilityPoolFeeFromEvent);
            } else {
                expect(newStabilityPoolSbdBalance, "StabilityPool SBD balance should not change").to.equal(prevStabilityPoolSbdBalance);
            }
        } catch (e: any) {
            console.error("DFIDToken state validation failed: ", e.message);
            validationPassed = false;
        }

        // 4. ETH Balance Validation (Actor's ETH balance)
        const gasUsed = BigInt(executionReceipt.gasUsed);
        const gasPrice = BigInt(executionReceipt.effectiveGasPrice);
        const txCost = gasUsed * gasPrice;

        const prevActorEthBalance = previousSnapshot.accountSnapshot[actorAddress];
        const newActorEthBalance = newSnapshot.accountSnapshot[actorAddress];

        try {
            expect(newActorEthBalance, "Actor ETH balance not updated by transaction cost").to.equal(prevActorEthBalance - txCost);
        } catch (e: any) {
            console.error("Actor ETH balance validation failed: ", e.message);
            validationPassed = false;
        }

        // 5. OrderedDoublyLinkedList (safesOrderedForRedemption) Contract State Validation
        const newRedemptionListSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        const redemptionQueueUpdatedArgs = redemptionQueueUpdatedEvent!.args;
        const redemptionQueuePrevNode = redemptionQueueUpdatedArgs.prevNode as bigint; // The ID of the node before 'safeId' in the updated queue

        try {
            expect(newRedemptionListSnapshot.nodes[safeId.toString()].value, "Redemption queue node value incorrect").to.equal(newSafe.weight);
            expect(newRedemptionListSnapshot.nodes[safeId.toString()].prev, "Redemption queue node prev pointer incorrect").to.equal(redemptionQueuePrevNode);

            // If the prevNode is not 0, then its next pointer should point to safeId
            if (redemptionQueuePrevNode !== 0n) {
                expect(newRedemptionListSnapshot.nodes[redemptionQueuePrevNode.toString()].next, "Redemption queue prevNode's next pointer incorrect").to.equal(safeId);
            } else {
                // If prevNode is 0, then safeId should be the new head
                expect(newRedemptionListSnapshot.headId, "Redemption queue headId incorrect if prevNode is 0").to.equal(safeId);
            }

            // If safeId became the new tail (i.e. its next pointer is 0)
            if (newRedemptionListSnapshot.nodes[safeId.toString()].next === 0n) {
                expect(newRedemptionListSnapshot.tailId, "Redemption queue tailId incorrect").to.equal(safeId);
            }
        } catch (e: any) {
            console.error("OrderedDoublyLinkedList state validation failed: ", e.message);
            validationPassed = false;
        }

        // 6. DFIREStaking Contract State Validation
        const prevDfireStakingTotalStake = previousSnapshot.contractSnapshot.dfireStaking.totalStake;
        const prevDfireStakingTotalRewardPerToken = previousSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;
        const newDfireStakingTotalRewardPerToken = newSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;

        try {
            if (rewardAddedDFIREStakingEvent && prevDfireStakingTotalStake > 0n) {
                const expectedIncrease = (sbrStakersFeeFromEvent * PRECISION) / prevDfireStakingTotalStake;
                expect(newDfireStakingTotalRewardPerToken, "DFIREStaking totalRewardPerToken incorrect").to.equal(prevDfireStakingTotalRewardPerToken + expectedIncrease);
            } else {
                // If reward was not added (e.g., totalStake was 0 or transfer failed), totalRewardPerToken should not change
                expect(newDfireStakingTotalRewardPerToken, "DFIREStaking totalRewardPerToken should not change").to.equal(prevDfireStakingTotalRewardPerToken);
            }
        } catch (e: any) {
            console.error("DFIREStaking state validation failed: ", e.message);
            validationPassed = false;
        }

        // 7. StabilityPool Contract State Validation
        const prevStabilityPool = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPool = newSnapshot.contractSnapshot.stabilityPool;

        try {
            if (rewardAddedStabilityPoolEvent && prevStabilityPool.totalStakedRaw > 0n) {
                const _totalAmount = stabilityPoolFeeFromEvent + prevStabilityPool.rewardLoss;
                const _rewardPerToken = ((_totalAmount * prevStabilityPool.stakeScalingFactor * prevStabilityPool.precision) / prevStabilityPool.totalStakedRaw) / prevStabilityPool.precision;
                const expectedNewTotalRewardPerToken = prevStabilityPool.totalRewardPerToken + _rewardPerToken;
                const expectedNewRewardLoss = _totalAmount - (((_rewardPerToken * prevStabilityPool.totalStakedRaw * prevStabilityPool.precision) / prevStabilityPool.stakeScalingFactor) / prevStabilityPool.precision);

                expect(newStabilityPool.totalRewardPerToken, "StabilityPool totalRewardPerToken incorrect").to.equal(expectedNewTotalRewardPerToken);
                expect(newStabilityPool.rewardLoss, "StabilityPool rewardLoss incorrect").to.equal(expectedNewRewardLoss);
            } else {
                // If reward was not added (e.g., totalStakedRaw was 0 or transfer failed), totalRewardPerToken and rewardLoss should not change
                expect(newStabilityPool.totalRewardPerToken, "StabilityPool totalRewardPerToken should not change").to.equal(prevStabilityPool.totalRewardPerToken);
                expect(newStabilityPool.rewardLoss, "StabilityPool rewardLoss should not change").to.equal(prevStabilityPool.rewardLoss);
            }

            // SBR Reward specific validations (if _addSBRRewards was triggered, indicated by SBRRewardsAdded event)
            if (sbrRewardsAddedEvent) {
                // These are complex internal updates; check that they have changed as expected
                expect(newStabilityPool.lastSBRRewardDistributedTime, "lastSBRRewardDistributedTime should have updated").to.not.equal(prevStabilityPool.lastSBRRewardDistributedTime);
                expect(newStabilityPool.sbrRewardDistributionStatus, "sbrRewardDistributionStatus should have updated").to.not.equal(prevStabilityPool.sbrRewardDistributionStatus);
                // sbrRewardDistributionEndTime should be set if status was NOT_STARTED
                if (prevStabilityPool.sbrRewardDistributionStatus === 0n /* NOT_STARTED */) {
                     expect(newStabilityPool.sbrRewardDistributionEndTime, "sbrRewardDistributionEndTime should have been set").to.not.equal(0n);
                }
                expect(newStabilityPool.totalSbrRewardPerToken, "totalSbrRewardPerToken should have updated").to.not.equal(prevStabilityPool.totalSbrRewardPerToken);
                expect(newStabilityPool.sbrRewardLoss, "sbrRewardLoss should have updated").to.not.equal(prevStabilityPool.sbrRewardLoss);

            } else {
                // If SBRRewardsAdded event is NOT emitted, these should NOT change.
                expect(newStabilityPool.lastSBRRewardDistributedTime, "lastSBRRewardDistributedTime should not have updated").to.equal(prevStabilityPool.lastSBRRewardDistributedTime);
                expect(newStabilityPool.sbrRewardDistributionEndTime, "sbrRewardDistributionEndTime should not have updated").to.equal(prevStabilityPool.sbrRewardDistributionEndTime);
                expect(newStabilityPool.sbrRewardDistributionStatus, "sbrRewardDistributionStatus should not have updated").to.equal(prevStabilityPool.sbrRewardDistributionStatus);
                expect(newStabilityPool.totalSbrRewardPerToken, "totalSbrRewardPerToken should not have updated").to.equal(prevStabilityPool.totalSbrRewardPerToken);
                expect(newStabilityPool.sbrRewardLoss, "sbrRewardLoss should not have updated").to.equal(prevStabilityPool.sbrRewardLoss);
            }

        } catch (e: any) {
            console.error("StabilityPool state validation failed: ", e.message);
            validationPassed = false;
        }

        return validationPassed;
    }
}
