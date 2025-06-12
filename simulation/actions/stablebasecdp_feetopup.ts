import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import { expect } from 'chai';
import { ethers } from 'ethers';

// Define constants based on the provided context
const BASIS_POINTS_DIVISOR = 10000n;
const PRECISION = 10n ** 18n;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * (10n ** 18n);

export class FeeTopupAction extends Action {
    private stableBaseCDPContract: ethers.Contract;

    constructor(stableBaseCDPContract: ethers.Contract) {
        super("FeeTopupAction");
        this.stableBaseCDPContract = stableBaseCDPContract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
        const safesOrderedForRedemptionSnapshot = currentSnapshot.contractSnapshot.safesOrderedForRedemption;
        const actorAddress = actor.account.address;

        const ownedSafeIds: bigint[] = [];
        for (const safeIdStr in stableBaseCDPSnapshot.safeOwner) {
            const safeId = BigInt(safeIdStr);
            if (stableBaseCDPSnapshot.safeOwner[safeId] === actorAddress) {
                const safeDetails = stableBaseCDPSnapshot.safeDetails[safeId];
                // A valid CDP for fee topup should typically have a borrowed amount
                if (safeDetails && safeDetails.borrowedAmount > 0n) {
                    ownedSafeIds.push(safeId);
                }
            }
        }

        if (ownedSafeIds.length === 0) {
            return [false, {}, {}];
        }

        const safeId = ownedSafeIds[Number(context.prng.next() % BigInt(ownedSafeIds.length))];
        const safe = stableBaseCDPSnapshot.safeDetails[safeId];

        if (safe.borrowedAmount === 0n) {
            // Defensive check, should already be filtered by ownedSafeIds logic
            return [false, {}, {}];
        }

        const actorSbdBalance = dfidTokenSnapshot.accountBalances[actorAddress] || 0n;

        // Calculate max topupRate based on actor's SBD balance
        // max_topupRate = (actorSbdBalance * BASIS_POINTS_DIVISOR) / safe.borrowedAmount
        const maxAffordableTopupRate = (actorSbdBalance * BASIS_POINTS_DIVISOR) / safe.borrowedAmount;

        const maxPracticalTopupRate = 10000n; // A practical upper limit for topupRate (e.g., 100% of borrowed amount as fee if borrowedAmount is 1 unit and BASIS_POINTS_DIVISOR is 10000)

        const upperLimitForTopupRate = maxAffordableTopupRate > 0n ? (maxAffordableTopupRate < maxPracticalTopupRate ? maxAffordableTopupRate : maxPracticalTopupRate) : 0n;

        if (upperLimitForTopupRate === 0n) {
            return [false, {}, {}]; // Cannot afford any topup or no practical rate possible
        }

        let topupRate = BigInt(context.prng.next()) % upperLimitForTopupRate + 1n; // Ensure positive and within limits

        const fee = (topupRate * safe.borrowedAmount) / BASIS_POINTS_DIVISOR;

        // Final check to ensure fee can be paid, especially after capping topupRate for practicality
        if (actorSbdBalance < fee) {
            return [false, {}, {}];
        }

        let nearestSpotInRedemptionQueue: bigint = 0n;
        const redemptionNodes = Object.keys(safesOrderedForRedemptionSnapshot.nodes)
            .map(id => BigInt(id));

        if (redemptionNodes.length > 0) {
            const useZero = context.prng.next() % 2 === 0; // Randomly choose between 0 and an existing node
            if (!useZero) {
                // Pick a random existing node ID
                nearestSpotInRedemptionQueue = redemptionNodes[Number(context.prng.next() % BigInt(redemptionNodes.length))];
            }
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
        const signer = actor.account.value;
        const stableBaseCDPContractInstance = this.stableBaseCDPContract.connect(signer);
        const dfidTokenContractInstance = context.contracts.dfidToken.connect(signer); // Access dfidToken via context.contracts

        const stableBaseCDPAddress = this.stableBaseCDPContract.target;

        const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safeDetails[actionParams.safeId];
        const fee = (actionParams.topupRate * safe.borrowedAmount) / BASIS_POINTS_DIVISOR;

        const currentAllowance = currentSnapshot.contractSnapshot.dfidToken.accountAllowances[actor.account.address]?.[stableBaseCDPAddress as string] || 0n;

        // Approve if current allowance is less than the fee required
        if (currentAllowance < fee) {
            const approveTx = await dfidTokenContractInstance.approve(stableBaseCDPAddress, fee);
            await approveTx.wait();
        }

        const tx = await stableBaseCDPContractInstance.feeTopup(
            actionParams.safeId,
            actionParams.topupRate,
            actionParams.nearestSpotInRedemptionQueue
        );
        const receipt = await tx.wait();
        return receipt as ExecutionReceipt;
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const actorAddress = actor.account.address;
        const stableBaseCDPAddress = this.stableBaseCDPContract.target as string;
        const dfidTokenContract = context.contracts.dfidToken;
        const dfidTokenAddress = dfidTokenContract.target as string;
        const dfireStakingContract = context.contracts.dfireStaking;
        const dfireStakingAddress = dfireStakingContract.target as string;
        const stabilityPoolContract = context.contracts.stabilityPool;
        const stabilityPoolAddress = stabilityPoolContract.target as string;


        const gasUsed = BigInt(executionReceipt.gasUsed);
        const gasPrice = BigInt(executionReceipt.gasPrice);
        const gasCost = gasUsed * gasPrice;

        const findEvent = (receipt: ExecutionReceipt, contractAddress: string, eventSignature: string) => {
            const eventTopic = ethers.id(eventSignature);
            return receipt.events.find(e =>
                e.address.toLowerCase() === contractAddress.toLowerCase() &&
                e.topics[0] === eventTopic
            );
        };

        const prevStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;
        const prevDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;
        const prevDFIREStaking = previousSnapshot.contractSnapshot.dfireStaking;
        const newDFIREStaking = newSnapshot.contractSnapshot.dfireStaking;
        const prevStabilityPool = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPool = newSnapshot.contractSnapshot.stabilityPool;
        const prevRedemptionQueue = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const newRedemptionQueue = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        const { safeId, topupRate } = actionParams;

        const prevSafe = prevStableBaseCDP.safeDetails[safeId];
        const newSafe = newStableBaseCDP.safeDetails[safeId];

        // --- Calculate expected values from events ---
        const feeTopupEvent = findEvent(executionReceipt, stableBaseCDPAddress, "FeeTopup(uint256,uint256,uint256,uint256)");
        expect(feeTopupEvent, "FeeTopup event not emitted").to.exist;
        const emittedFee = BigInt(feeTopupEvent.args[2]);
        const emittedNewWeight = BigInt(feeTopupEvent.args[3]);

        const feeDistributedEvent = findEvent(executionReceipt, stableBaseCDPAddress, "FeeDistributed(uint256,uint256,bool,uint256,uint256,uint256)");
        expect(feeDistributedEvent, "FeeDistributed event not emitted").to.exist;
        const emittedSbrStakersFee = BigInt(feeDistributedEvent.args[3]);
        const emittedStabilityPoolFee = BigInt(feeDistributedEvent.args[4]);
        const emittedCanRefund = BigInt(feeDistributedEvent.args[5]);

        // --- StableBaseCDP Contract State Validation ---
        expect(newSafe.weight, "safe.weight not updated correctly").to.equal(emittedNewWeight);
        expect(newSafe.weight, "safe.weight must increase by topupRate").to.equal(prevSafe.weight + topupRate);
        expect(newSafe.feePaid, "safe.feePaid not updated correctly").to.equal(prevSafe.feePaid + emittedFee);

        const safeUpdatedEvent = findEvent(executionReceipt, stableBaseCDPAddress, "SafeUpdated(uint256,uint256,uint256,uint256,uint256,uint256,uint256)");

        // The following block validates state changes related to _updateSafe. 
        // The `liquidationSnapshots` property is expected to be present in `StableBaseCDPSnapshot` 
        // as per the action summary's state update and validation rules, even if it's not explicitly 
        // listed in the provided `StableBaseCDPSnapshot` interface snippet.
        if (safeUpdatedEvent) {
            const emittedCollateralAmount = BigInt(safeUpdatedEvent.args[1]);
            const emittedBorrowedAmount = BigInt(safeUpdatedEvent.args[2]);
            const emittedCollateralIncrease = BigInt(safeUpdatedEvent.args[3]);
            const emittedDebtIncrease = BigInt(safeUpdatedEvent.args[4]);
            const emittedTotalCollateral = BigInt(safeUpdatedEvent.args[5]);
            const emittedTotalDebt = BigInt(safeUpdatedEvent.args[6]);

            expect(newSafe.collateralAmount, "newSafe.collateralAmount mismatch").to.equal(emittedCollateralAmount);
            expect(newSafe.borrowedAmount, "newSafe.borrowedAmount mismatch").to.equal(emittedBorrowedAmount);

            // Assuming liquidationSnapshots exists on StableBaseCDPSnapshot as per action summary
            const newLiquidationSnapshot = newStableBaseCDP.liquidationSnapshots[safeId];
            expect(newLiquidationSnapshot.collateralPerCollateralSnapshot, "liquidationSnapshot.collateralPerCollateralSnapshot not updated").to.equal(newStableBaseCDP.cumulativeCollateralPerUnitCollateral);
            expect(newLiquidationSnapshot.debtPerCollateralSnapshot, "liquidationSnapshot.debtPerCollateralSnapshot not updated").to.equal(newStableBaseCDP.cumulativeDebtPerUnitCollateral);

            expect(newStableBaseCDP.totalCollateral, "totalCollateral mismatch").to.equal(emittedTotalCollateral);
            expect(newStableBaseCDP.totalDebt, "totalDebt mismatch").to.equal(emittedTotalDebt);
        } else {
            // If SafeUpdated event was not emitted, it means _updateSafe condition was not met.
            // Thus, collateralAmount, borrowedAmount, liquidationSnapshots, totalCollateral, totalDebt should remain unchanged.
            expect(newSafe.collateralAmount, "newSafe.collateralAmount should not change if _updateSafe not called").to.equal(prevSafe.collateralAmount);
            expect(newSafe.borrowedAmount, "newSafe.borrowedAmount should not change if _updateSafe not called").to.equal(prevSafe.borrowedAmount);
            // Assuming liquidationSnapshots exists on StableBaseCDPSnapshot as per action summary
            const prevLiquidationSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId];
            const newLiquidationSnapshot = newStableBaseCDP.liquidationSnapshots[safeId];
            expect(newLiquidationSnapshot.collateralPerCollateralSnapshot, "liquidationSnapshot.collateralPerCollateralSnapshot should not change if _updateSafe not called").to.equal(prevLiquidationSnapshot.collateralPerCollateralSnapshot);
            expect(newLiquidationSnapshot.debtPerCollateralSnapshot, "liquidationSnapshot.debtPerCollateralSnapshot should not change if _updateSafe not called").to.equal(prevLiquidationSnapshot.debtPerCollateralSnapshot);
            expect(newStableBaseCDP.totalCollateral, "totalCollateral should not change if _updateSafe not called").to.equal(prevStableBaseCDP.totalCollateral);
            expect(newStableCDP.totalDebt, "totalDebt should not change if _updateSafe not called").to.equal(prevStableCDP.totalDebt);
        }

        if (newStableBaseCDP.totalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD && prevStableBaseCDP.protocolMode === 0) { // 0 for BOOTSTRAP
            expect(newStableBaseCDP.protocolMode, "PROTOCOL_MODE should transition to NORMAL").to.equal(1); // 1 for NORMAL
        } else {
            expect(newStableBaseCDP.protocolMode, "PROTOCOL_MODE should remain unchanged").to.equal(prevStableBaseCDP.protocolMode);
        }

        // --- DFIDToken (sbdToken) Contract State Validation ---
        const feeTransferEvent = findEvent(executionReceipt, dfidTokenAddress, "Transfer(address,address,uint256)");
        expect(feeTransferEvent, "SBD Token Transfer (fee payment) event not emitted").to.exist;
        expect(BigInt(feeTransferEvent.args[2]), "Transferred fee must match emittedFee").to.equal(emittedFee);
        expect(feeTransferEvent.args[0].toLowerCase(), "Transfer from address mismatch").to.equal(actorAddress.toLowerCase());
        expect(feeTransferEvent.args[1].toLowerCase(), "Transfer to address mismatch").to.equal(stableBaseCDPAddress.toLowerCase());

        let expectedActorSbdBalance = (prevDFIDToken.accountBalances[actorAddress] || 0n) - emittedFee;
        let expectedCDPSbdBalance = (prevDFIDToken.accountBalances[stableBaseCDPAddress] || 0n) + emittedFee;
        let expectedDFIREStakingSbdBalance = (prevDFIDToken.accountBalances[dfireStakingAddress] || 0n);
        let expectedStabilityPoolSbdBalance = (prevDFIDToken.accountBalances[stabilityPoolAddress] || 0n);

        let refundFee = 0n;
        if (emittedCanRefund > 0n) {
            const feeRefundEvent = findEvent(executionReceipt, stableBaseCDPAddress, "FeeRefund(uint256,uint256)");
            expect(feeRefundEvent, "FeeRefund event not emitted for refund > 0").to.exist;
            refundFee = BigInt(feeRefundEvent.args[1]);
            expect(refundFee, "Emitted refundFee mismatch").to.equal(emittedCanRefund);

            const refundTransferEvent = executionReceipt.events.find(e =>
                e.address.toLowerCase() === dfidTokenAddress.toLowerCase() &&
                e.topics[0] === ethers.id("Transfer(address,address,uint256)") &&
                e.args[0].toLowerCase() === stableBaseCDPAddress.toLowerCase() &&
                e.args[1].toLowerCase() === actorAddress.toLowerCase()
            );
            expect(refundTransferEvent, "SBD Token Transfer (refund) event not emitted").to.exist;
            expect(BigInt(refundTransferEvent.args[2]), "Refund transfer amount mismatch").to.equal(refundFee);

            expectedActorSbdBalance += refundFee;
            expectedCDPSbdBalance -= refundFee;
        }

        expect(newDFIDToken.accountBalances[actorAddress] || 0n, "Actor SBD balance mismatch").to.equal(expectedActorSbdBalance);
        expect(newDFIDToken.accountBalances[stableBaseCDPAddress] || 0n, "StableBaseCDP SBD balance mismatch").to.equal(expectedCDPSbdBalance);

        // DFIREStaking Fee
        if (emittedSbrStakersFee > 0n) {
            const dfireRewardAddedEvent = findEvent(executionReceipt, dfireStakingAddress, "RewardAdded(uint256)");
            if (prevDFIREStaking.totalStake > 0n) {
                expect(dfireRewardAddedEvent, "DFIREStaking RewardAdded event not emitted when totalStake > 0").to.exist;
                expect(newDFIREStaking.totalRewardPerToken, "DFIREStaking totalRewardPerToken mismatch").to.equal(prevDFIREStaking.totalRewardPerToken + (emittedSbrStakersFee * PRECISION) / prevDFIREStaking.totalStake);
                expectedDFIREStakingSbdBalance += emittedSbrStakersFee;
            } else {
                expect(dfireRewardAddedEvent, "DFIREStaking RewardAdded event emitted when totalStake is 0").to.not.exist;
                expect(newDFIREStaking.totalRewardPerToken, "DFIREStaking totalRewardPerToken should not change if totalStake was 0").to.equal(prevDFIREStaking.totalRewardPerToken);
            }
        }
        expect(newDFIDToken.accountBalances[dfireStakingAddress] || 0n, "DFIREStaking SBD balance mismatch").to.equal(expectedDFIREStakingSbdBalance);


        // StabilityPool Fee
        if (emittedStabilityPoolFee > 0n) {
            const stabilityPoolRewardAddedEvent = findEvent(executionReceipt, stabilityPoolAddress, "RewardAdded(uint256)");
            if (prevStabilityPool.totalStakedRaw > 0n) {
                expect(stabilityPoolRewardAddedEvent, "StabilityPool RewardAdded event not emitted when totalStakedRaw > 0").to.exist;
                expectedStabilityPoolSbdBalance += emittedStabilityPoolFee;
                // totalRewardPerToken and rewardLoss are complex calculations, checking for change
                expect(newStabilityPool.totalRewardPerToken).to.not.equal(prevStabilityPool.totalRewardPerToken);
                expect(newStabilityPool.rewardLoss).to.not.equal(prevStabilityPool.rewardLoss);
            } else {
                expect(stabilityPoolRewardAddedEvent, "StabilityPool RewardAdded event emitted when totalStakedRaw is 0").to.not.exist;
                expect(newStabilityPool.totalRewardPerToken, "StabilityPool totalRewardPerToken should not change if totalStakedRaw was 0").to.equal(prevStabilityPool.totalRewardPerToken);
                expect(newStabilityPool.rewardLoss, "StabilityPool rewardLoss should not change if totalStakedRaw was 0").to.equal(prevStabilityPool.rewardLoss);
            }
        }
        expect(newDFIDToken.accountBalances[stabilityPoolAddress] || 0n, "StabilityPool SBD balance mismatch").to.equal(expectedStabilityPoolSbdBalance);

        // --- OrderedDoublyLinkedList (safesOrderedForRedemption) State Validation ---
        const redemptionQueueUpdatedEvent = findEvent(executionReceipt, stableBaseCDPAddress, "RedemptionQueueUpdated(uint256,uint256,uint256)");
        expect(redemptionQueueUpdatedEvent, "RedemptionQueueUpdated event not emitted").to.exist;
        expect(BigInt(redemptionQueueUpdatedEvent.args[0]), "RedemptionQueueUpdated event safeId mismatch").to.equal(safeId);
        expect(BigInt(redemptionQueueUpdatedEvent.args[1]), "RedemptionQueueUpdated event newWeight mismatch").to.equal(newSafe.weight);
        const emittedRedemptionQueuePrevNode = BigInt(redemptionQueueUpdatedEvent.args[2]);

        const newNode = newRedemptionQueue.nodes[safeId.toString()];
        expect(newNode, `Node for safeId ${safeId} not found in new redemption queue`).to.exist;
        expect(newNode.value, "Redemption queue node value mismatch").to.equal(newSafe.weight);
        expect(newNode.prev, "Redemption queue node prev pointer mismatch").to.equal(emittedRedemptionQueuePrevNode);

        // --- StabilityPool Contract State Validation (continued - SBR specific) ---
        const sbrRewardsAddedEvent = findEvent(executionReceipt, stabilityPoolAddress, "SBRRewardsAdded(uint256,uint256,uint256,uint256)");
        if (prevStabilityPool.sbrRewardDistributionStatus !== 2n) { // 2n is SBRRewardDistribution.ENDED
            if (prevStabilityPool.totalStakedRaw > 0n) {
                expect(sbrRewardsAddedEvent, "SBRRewardsAdded event not emitted").to.exist;
                expect(newStabilityPool.lastSBRRewardDistributedTime, "lastSBRRewardDistributedTime should update").to.not.equal(prevStabilityPool.lastSBRRewardDistributedTime);
                expect(newStabilityPool.totalSbrRewardPerToken, "totalSbrRewardPerToken should update").to.not.equal(prevStabilityPool.totalSbrRewardPerToken);
                expect(newStabilityPool.sbrRewardLoss, "sbrRewardLoss should update").to.not.equal(prevStabilityPool.sbrRewardLoss);
            } else {
                expect(sbrRewardsAddedEvent, "SBRRewardsAdded event emitted when totalStakedRaw is 0").to.not.exist;
                // If totalStakedRaw was 0, these should not change (unless status was NOT_STARTED and changed)
                expect(newStabilityPool.lastSBRRewardDistributedTime, "lastSBRRewardDistributedTime should not change if totalStakedRaw was 0").to.equal(prevStabilityPool.lastSBRRewardDistributedTime);
                expect(newStabilityPool.totalSbrRewardPerToken, "totalSbrRewardPerToken should not change if totalStakedRaw was 0").to.equal(prevStabilityPool.totalSbrRewardPerToken);
                expect(newStabilityPool.sbrRewardLoss, "sbrRewardLoss should not change if totalStakedRaw was 0").to.equal(prevStabilityPool.sbrRewardLoss);
            }

            if (prevStabilityPool.sbrRewardDistributionStatus === 0n) { // 0n is SBRRewardDistribution.NOT_STARTED
                expect(newStabilityPool.sbrRewardDistributionStatus, "SBR status should change from NOT_STARTED to STARTED").to.equal(1n); // 1n is SBRRewardDistribution.STARTED
                expect(newStabilityPool.sbrRewardDistributionEndTime, "sbrRewardDistributionEndTime should be set").to.not.equal(0n); // Should be block.timestamp + 365 days
            } else if (prevStabilityPool.sbrRewardDistributionStatus === 1n) { // 1n is SBRRewardDistribution.STARTED
                // Due to time-dependent nature, we can only check if it transitions to ENDED or stays STARTED
                // based on whether current block time (represented by receipt.blockNumber for testing) crossed the end time.
                // This is a simplified check, full block.timestamp check is complex without direct access to block.timestamp.
                if (BigInt(executionReceipt.blockNumber) * 1000n > prevStabilityPool.sbrRewardDistributionEndTime) { // Approx block.timestamp in milliseconds
                    expect(newStabilityPool.sbrRewardDistributionStatus, "SBR status should change from STARTED to ENDED").to.equal(2n); // 2n is SBRRewardDistribution.ENDED
                } else {
                    expect(newStabilityPool.sbrRewardDistributionStatus, "SBR status should remain STARTED").to.equal(1n); // 1n is SBRRewardDistribution.STARTED
                }
            }
        } else { // status was ENDED
            expect(newStabilityPool.lastSBRRewardDistributedTime, "lastSBRRewardDistributedTime should not change if ENDED").to.equal(prevStabilityPool.lastSBRRewardDistributedTime);
            expect(newStabilityPool.sbrRewardDistributionEndTime, "sbrRewardDistributionEndTime should not change if ENDED").to.equal(prevStabilityPool.sbrRewardDistributionEndTime);
            expect(newStabilityPool.sbrRewardDistributionStatus, "sbrRewardDistributionStatus should remain ENDED").to.equal(prevStabilityPool.sbrRewardDistributionStatus);
            expect(newStabilityPool.totalSbrRewardPerToken, "totalSbrRewardPerToken should not change if ENDED").to.equal(prevStabilityPool.totalSbrRewardPerToken);
            expect(newStabilityPool.sbrRewardLoss, "sbrRewardLoss should not change if ENDED").to.equal(prevStabilityPool.sbrRewardLoss);
            expect(sbrRewardsAddedEvent, "SBRRewardsAdded event emitted when status is ENDED").to.not.exist;
        }

        // --- Account ETH Balance Validation ---
        const prevActorEthBalance = previousSnapshot.accountSnapshot[actorAddress] || 0n;
        const newActorEthBalance = newSnapshot.accountSnapshot[actorAddress] || 0n;
        expect(newActorEthBalance, "Actor ETH balance mismatch").to.equal(prevActorEthBalance - gasCost);

        return true;
    }
}
