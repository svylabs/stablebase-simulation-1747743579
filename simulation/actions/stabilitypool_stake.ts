import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from 'chai';
import {ethers} from 'ethers';

// Helper to cast to BigInt
const toBn = (value: any) => BigInt(value);

export class StakeAction extends Action {
    private contract: ethers.Contract;
    private dfidTokenContract: ethers.Contract;
    private dfireTokenContract: ethers.Contract;
    private stableBaseCDPContract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("StakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        // Retrieve contract instances from context
        this.dfidTokenContract = context.contracts.dfidToken as ethers.Contract;
        this.dfireTokenContract = context.contracts.dfireToken as ethers.Contract;
        this.stableBaseCDPContract = context.contracts.stableBaseCDP as ethers.Contract;

        const actorAddress = actor.account.address;
        const stabilityPoolAddress = this.contract.target;

        // 1. Get actor's DFIDToken balance
        const actorDFIDBalance = toBn(currentSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress] || 0n);

        // 2. Get actor's DFIDToken allowance for StabilityPool
        const allowance = toBn(currentSnapshot.contractSnapshot.dfidToken.accountAllowances[actorAddress]?.[stabilityPoolAddress] || 0n);

        // Calculate max possible amount to stake
        const maxStakeableAmount = actorDFIDBalance < allowance ? actorDFIDBalance : allowance;

        if (maxStakeableAmount === 0n) {
            // Cannot stake if balance or allowance is zero
            return [false, {}, {}];
        }

        // Generate a random amount to stake
        // _amount must be a positive integer
        // Use context.prng.next() for random number generation
        let _amount: bigint;
        // Ensure _amount is at least 1 and not greater than maxStakeableAmount.
        // context.prng.next() gives [0, 4294967296)
        _amount = toBn(context.prng.next()) % maxStakeableAmount + 1n; 
        
        // If _amount ends up being 0 due to edge case (maxStakeableAmount being 0 or very small) or if it exceeds max, clamp it.
        if (_amount > maxStakeableAmount) {
            _amount = maxStakeableAmount;
        }
        if (_amount === 0n && maxStakeableAmount > 0n) {
            _amount = 1n; // Ensure positive if staking is possible
        } else if (_amount === 0n && maxStakeableAmount === 0n) {
            return [false, {}, {}]; // Still no stake possible
        }

        // Generate frontend address
        const frontend = ethers.ZeroAddress; 

        // Generate fee parameter
        // Max basis points is 10000 (100%). Let's pick between 0 and 1000 (0% to 10%)
        const fee = toBn(context.prng.next() % 1001); // Random fee between 0 and 1000 basis points

        const actionParams = {
            _amount,
            frontend,
            fee
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { _amount, frontend, fee } = actionParams;
        const signer = actor.account.value as ethers.Signer;

        this.dfidTokenContract = context.contracts.dfidToken as ethers.Contract;
        this.dfireTokenContract = context.contracts.dfireToken as ethers.Contract;
        this.stableBaseCDPContract = context.contracts.stableBaseCDP as ethers.Contract;

        const connectedContract = this.contract.connect(signer);
        const tx = await connectedContract.stake(_amount, frontend, fee);
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
        const { _amount, frontend, fee } = actionParams;
        const actorAddress = actor.account.address;
        const stabilityPoolAddress = this.contract.target;

        // Precision and BASIS_POINTS_DIVISOR constants from contract context
        const PRECISION = toBn(previousSnapshot.contractSnapshot.stabilityPool.precision);
        const BASIS_POINTS_DIVISOR = toBn(previousSnapshot.contractSnapshot.stabilityPool.BASIS_POINTS_DIVISOR);

        // --- 1. Capture Pre-execution State --- //
        const prevActorDFIDBalance = toBn(previousSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress] || 0n);
        const prevStabilityPoolDFIDBalance = toBn(previousSnapshot.contractSnapshot.dfidToken.accountBalances[stabilityPoolAddress] || 0n);
        const prevActorEthBalance = toBn(previousSnapshot.accountSnapshot[actorAddress] || 0n);
        const prevStabilityPoolUserStake = toBn(previousSnapshot.contractSnapshot.stabilityPool.users[actorAddress]?.stake || 0n);
        const prevStabilityPoolTotalStakedRaw = toBn(previousSnapshot.contractSnapshot.stabilityPool.totalStakedRaw || 0n);
        const prevStabilityPoolRewardSenderActive = previousSnapshot.contractSnapshot.stabilityPool.rewardSenderActive;
        const prevStableBaseCDPCanStabilityPoolReceiveRewards = previousSnapshot.contractSnapshot.stableBaseCDP.canStabilityPoolReceiveRewards;
        const prevDFIRETokenTotalSupply = toBn(previousSnapshot.contractSnapshot.dfireToken.tokenTotalSupply || 0n);
        const prevStabilityPoolSbrRewardDistributionStatus = toBn(previousSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionStatus);
        const prevStabilityPoolLastSBRRewardDistributedTime = toBn(previousSnapshot.contractSnapshot.stabilityPool.lastSBRRewardDistributedTime);
        const prevStabilityPoolSbrRewardDistributionEndTime = toBn(previousSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionEndTime);
        const prevSbrRewardSnapshotStatus = toBn(previousSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[actorAddress]?.status || 0n);
        const prevTotalSbrRewardPerToken = toBn(previousSnapshot.contractSnapshot.stabilityPool.totalSbrRewardPerToken || 0n);
        const prevSbrDistributionRate = toBn(previousSnapshot.contractSnapshot.stabilityPool.sbrDistributionRate || 0n);
        const prevStabilityPoolSbrRewardLoss = toBn(previousSnapshot.contractSnapshot.stabilityPool.sbrRewardLoss || 0n);

        let prevFrontendDFIDBalance = 0n;
        let prevFrontendEthBalance = 0n;
        let prevFrontendDFIREBalance = 0n;
        if (frontend !== ethers.ZeroAddress) {
            prevFrontendDFIDBalance = toBn(previousSnapshot.contractSnapshot.dfidToken.accountBalances[frontend] || 0n);
            prevFrontendEthBalance = toBn(previousSnapshot.accountSnapshot[frontend] || 0n);
            prevFrontendDFIREBalance = toBn(previousSnapshot.contractSnapshot.dfireToken.accounts[frontend]?.balance || 0n);
        }

        // --- 2. Capture Post-execution State --- //
        const newActorDFIDBalance = toBn(newSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress] || 0n);
        const newStabilityPoolDFIDBalance = toBn(newSnapshot.contractSnapshot.dfidToken.accountBalances[stabilityPoolAddress] || 0n);
        const newActorEthBalance = toBn(newSnapshot.accountSnapshot[actorAddress] || 0n);
        const newStabilityPoolUserStake = toBn(newSnapshot.contractSnapshot.stabilityPool.users[actorAddress]?.stake || 0n);
        const newStabilityPoolTotalStakedRaw = toBn(newSnapshot.contractSnapshot.stabilityPool.totalStakedRaw || 0n);
        const newStabilityPoolUserRewardSnapshot = toBn(newSnapshot.contractSnapshot.stabilityPool.users[actorAddress]?.rewardSnapshot || 0n);
        const newStabilityPoolUserCollateralSnapshot = toBn(newSnapshot.contractSnapshot.stabilityPool.users[actorAddress]?.collateralSnapshot || 0n);
        const newStabilityPoolUserSbrRewardSnapshot = toBn(newSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[actorAddress]?.rewardSnapshot || 0n);
        const newStabilityPoolUserCumulativeProductScalingFactor = toBn(newSnapshot.contractSnapshot.stabilityPool.users[actorAddress]?.cumulativeProductScalingFactor || 0n);
        const newStabilityPoolUserStakeResetCount = toBn(newSnapshot.contractSnapshot.stabilityPool.users[actorAddress]?.stakeResetCount || 0n);
        const newStabilityPoolLastSBRRewardDistributedTime = toBn(newSnapshot.contractSnapshot.stabilityPool.lastSBRRewardDistributedTime);
        const newStabilityPoolSbrRewardDistributionStatus = toBn(newSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionStatus);
        const newStabilityPoolSbrRewardDistributionEndTime = toBn(newSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionEndTime);
        const newStabilityPoolTotalSbrRewardPerToken = toBn(newSnapshot.contractSnapshot.stabilityPool.totalSbrRewardPerToken);
        const newStabilityPoolSbrRewardLoss = toBn(newSnapshot.contractSnapshot.stabilityPool.sbrRewardLoss);
        const newStableBaseCDPCanStabilityPoolReceiveRewards = newSnapshot.contractSnapshot.stableBaseCDP.canStabilityPoolReceiveRewards;
        const newDFIRETokenTotalSupply = toBn(newSnapshot.contractSnapshot.dfireToken.tokenTotalSupply || 0n);

        let newFrontendDFIDBalance = 0n;
        let newFrontendEthBalance = 0n;
        let newFrontendDFIREBalance = 0n;
        if (frontend !== ethers.ZeroAddress) {
            newFrontendDFIDBalance = toBn(newSnapshot.contractSnapshot.dfidToken.accountBalances[frontend] || 0n);
            newFrontendEthBalance = toBn(newSnapshot.accountSnapshot[frontend] || 0n);
            newFrontendDFIREBalance = toBn(newSnapshot.contractSnapshot.dfireToken.accounts[frontend]?.balance || 0n);
        }

        // --- 3. Validate Events --- //
        let stakedEventFound = false;
        let rewardClaimedEventFound = false;
        let dfireRewardClaimedEventFound = false;
        let sbrRewardsAddedEventFound = false;

        let claimedReward = 0n;
        let claimedRewardFee = 0n;
        let claimedCollateral = 0n;
        let claimedCollateralFee = 0n;
        let claimedSbrReward = 0n;
        let claimedSbrRewardFee = 0n;
        let sbrAddedRewardAmount = 0n;

        for (const log of executionReceipt.logs) {
            try {
                // Parse Staked event
                if (log.topics[0] === this.contract.interface.getEvent('Staked').topicHash) {
                    const parsed = this.contract.interface.decodeEventLog('Staked', log.data, log.topics);
                    expect(parsed.user).to.equal(actorAddress, 'Staked event user mismatch');
                    expect(toBn(parsed.amount)).to.equal(_amount, 'Staked event amount mismatch');
                    stakedEventFound = true;
                }
                // Parse RewardClaimed event
                if (log.topics[0] === this.contract.interface.getEvent('RewardClaimed').topicHash) {
                    const parsed = this.contract.interface.decodeEventLog('RewardClaimed', log.data, log.topics);
                    expect(parsed.user).to.equal(actorAddress, 'RewardClaimed event user mismatch');
                    claimedReward = toBn(parsed.totalReward);
                    claimedRewardFee = toBn(parsed.rewardFrontendFee);
                    claimedCollateral = toBn(parsed.totalCollateral);
                    claimedCollateralFee = toBn(parsed.collateralFrontendFee);
                    rewardClaimedEventFound = true;
                }
                // Parse DFireRewardClaimed event
                if (log.topics[0] === this.contract.interface.getEvent('DFireRewardClaimed').topicHash) {
                    const parsed = this.contract.interface.decodeEventLog('DFireRewardClaimed', log.data, log.topics);
                    expect(parsed.user).to.equal(actorAddress, 'DFireRewardClaimed event user mismatch');
                    claimedSbrReward = toBn(parsed.amount);
                    claimedSbrRewardFee = toBn(parsed.frontendFee);
                    dfireRewardClaimedEventFound = true;
                }
                // Parse SBRRewardsAdded event
                if (log.topics[0] === this.contract.interface.getEvent('SBRRewardsAdded').topicHash) {
                    const parsed = this.contract.interface.decodeEventLog('SBRRewardsAdded', log.data, log.topics);
                    sbrAddedRewardAmount = toBn(parsed.rewardAmount);
                    sbrRewardsAddedEventFound = true;
                }
            } catch (error) {
                // Ignore logs that don't match expected event signatures or are from other contracts
            }
        }

        expect(stakedEventFound, 'Staked event not emitted').to.be.true;
        if (claimedReward > 0n || claimedCollateral > 0n || claimedSbrReward > 0n) { // Check if any reward was claimed
            expect(rewardClaimedEventFound, 'RewardClaimed event not emitted when rewards claimed').to.be.true;
        } else {
            expect(rewardClaimedEventFound, 'RewardClaimed event emitted when no non-SBR rewards claimed').to.be.false; // Only general rewards
        }
        if (claimedSbrReward > 0n) {
            expect(dfireRewardClaimedEventFound, 'DFireRewardClaimed event not emitted when SBR rewards claimed').to.be.true;
        } else {
            expect(dfireRewardClaimedEventFound, 'DFireRewardClaimed event emitted when no SBR rewards claimed').to.be.false;
        }

        // --- 4. Validate State Changes --- //

        // Core State Changes
        expect(newStabilityPoolUserStake).to.equal(prevStabilityPoolUserStake + _amount, 'StabilityPool.users[msg.sender].stake mismatch');
        expect(newStabilityPoolTotalStakedRaw).to.equal(prevStabilityPoolTotalStakedRaw + _amount, 'StabilityPool.totalStakedRaw mismatch');

        const expectedNetStabilityPoolDFIDChange = _amount - claimedReward; 
        expect(newStabilityPoolDFIDBalance).to.equal(prevStabilityPoolDFIDBalance + expectedNetStabilityPoolDFIDChange, 'StabilityPool DFIDToken balance mismatch');

        const expectedNetActorDFIDChange = (claimedReward - claimedRewardFee) - _amount; 
        expect(newActorDFIDBalance).to.equal(prevActorDFIDBalance + expectedNetActorDFIDChange, 'Actor DFIDToken balance mismatch');

        // Reward Claiming and Snapshots
        // Snapshots are taken after _claim, so they reflect the new global values (totalRewardPerToken, etc.)
        expect(newStabilityPoolUserRewardSnapshot).to.equal(newSnapshot.contractSnapshot.stabilityPool.totalRewardPerToken, 'User rewardSnapshot mismatch');
        expect(newStabilityPoolUserCollateralSnapshot).to.equal(newSnapshot.contractSnapshot.stabilityPool.totalCollateralPerToken, 'User collateralSnapshot mismatch');

        // SBR reward snapshot validation (sbrRewardSnapshots[msg.sender].rewardSnapshot and status)
        if (newStabilityPoolSbrRewardDistributionStatus !== 2n) { // SBRRewardDistribution.ENDED = 2
            expect(newStabilityPoolUserSbrRewardSnapshot).to.equal(newStabilityPoolTotalSbrRewardPerToken, 'User SBR rewardSnapshot mismatch (not ended)');
        } else { 
             // If SBR reward distribution has ended and not previously claimed
             if (prevSbrRewardSnapshotStatus !== 2n) { // If it wasn't CLAIMED before
                expect(newSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[actorAddress]?.status).to.equal(2n, 'User SBR status not set to CLAIMED when distribution ended');
             } else {
                expect(newSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[actorAddress]?.status).to.equal(prevSbrRewardSnapshotStatus, 'User SBR status should remain same if already CLAIMED');
             }
        }

        // User ETH balance (collateral rewards) - Account for gas cost
        const gasCost = toBn(executionReceipt.gasUsed) * toBn(executionReceipt.effectiveGasPrice);
        const expectedActorEthChange = (claimedCollateral - claimedCollateralFee) - gasCost;
        expect(newActorEthBalance).to.equal(prevActorEthBalance + expectedActorEthChange, 'Actor ETH balance mismatch');

        // User DFIREToken balance (SBR rewards)
        const expectedActorDFIREChange = claimedSbrReward - claimedSbrRewardFee;
        expect(toBn(newSnapshot.contractSnapshot.dfireToken.accounts[actorAddress]?.balance || 0n)).to.equal(toBn(previousSnapshot.contractSnapshot.dfireToken.accounts[actorAddress]?.balance || 0n) + expectedActorDFIREChange, 'Actor DFIREToken balance mismatch');

        // Frontend balances (if applicable)
        if (frontend !== ethers.ZeroAddress) {
            expect(newFrontendDFIDBalance).to.equal(prevFrontendDFIDBalance + claimedRewardFee, 'Frontend DFIDToken balance mismatch');
            expect(newFrontendEthBalance).to.equal(prevFrontendEthBalance + claimedCollateralFee, 'Frontend ETH balance mismatch');
            expect(newFrontendDFIREBalance).to.equal(prevFrontendDFIREBalance + claimedSbrRewardFee, 'Frontend DFIREToken balance mismatch');
        }

        // SBR Reward Distribution state validation (simulating _addSBRRewards logic)
        let expectedNewSbrRewardDistributionStatus = prevStabilityPoolSbrRewardDistributionStatus; // Assume it's final
        let expectedNewStabilityPoolLastSBRRewardDistributedTime = prevStabilityPoolLastSBRRewardDistributedTime;
        let expectedNewStabilityPoolSbrRewardDistributionEndTime = prevStabilityPoolSbrRewardDistributionEndTime;
        let expectedNewStabilityPoolTotalSbrRewardPerToken = prevTotalSbrRewardPerToken;
        let expectedNewStabilityPoolSbrRewardLoss = prevStabilityPoolSbrRewardLoss;

        const currentBlockTimestamp = toBn(executionReceipt.blockNumber);

        // Simulate `_addSBRRewards` logic only if the status is NOT_ENDED initially
        if (prevStabilityPoolSbrRewardDistributionStatus !== 2n) { // NOT_STARTED or STARTED
            if (prevStabilityPoolSbrRewardDistributionStatus === 1n) { // Was STARTED
                let timeElapsed = currentBlockTimestamp - prevStabilityPoolLastSBRRewardDistributedTime;
                if (currentBlockTimestamp > prevStabilityPoolSbrRewardDistributionEndTime) {
                    expectedNewSbrRewardDistributionStatus = 2n; // Becomes ENDED
                    timeElapsed = prevStabilityPoolSbrRewardDistributionEndTime - prevStabilityPoolLastSBRRewardDistributedTime;
                }
                const sbrRewardCalculated = timeElapsed * prevSbrDistributionRate;

                if (prevStabilityPoolTotalStakedRaw > 0n) {
                    const _sbrReward_accumulated = sbrRewardCalculated + prevStabilityPoolSbrRewardLoss;
                    const _totalSbrRewardPerToken_change = ((_sbrReward_accumulated * previousSnapshot.contractSnapshot.stabilityPool.stakeScalingFactor * PRECISION) / prevStabilityPoolTotalStakedRaw) / PRECISION;
                    expectedNewStabilityPoolTotalSbrRewardPerToken = prevTotalSbrRewardPerToken + _totalSbrRewardPerToken_change;
                    expectedNewStabilityPoolSbrRewardLoss = _sbrReward_accumulated - ((_totalSbrRewardPerToken_change * prevStabilityPoolTotalStakedRaw * PRECISION) / previousSnapshot.contractSnapshot.stabilityPool.stakeScalingFactor) / PRECISION;
                } else {
                    expectedNewStabilityPoolSbrRewardLoss = prevStabilityPoolSbrRewardLoss + sbrRewardCalculated; // If totalStakedRaw was 0, sbrReward is added to sbrRewardLoss
                }
                expectedNewStabilityPoolLastSBRRewardDistributedTime = currentBlockTimestamp; // Always updated to current block.timestamp if already STARTED

            } else if (prevStabilityPoolSbrRewardDistributionStatus === 0n) { // Was NOT_STARTED
                // When NOT_STARTED, _addSBRRewards initializes time and status, but timeElapsed will be 0 on first entry for reward calculation.
                expectedNewStabilityPoolLastSBRRewardDistributedTime = currentBlockTimestamp;
                expectedNewStabilityPoolSbrRewardDistributionEndTime = currentBlockTimestamp + 365n * 24n * 60n * 60n;
                expectedNewSbrRewardDistributionStatus = 1n; // Becomes STARTED
                // totalSbrRewardPerToken and sbrRewardLoss remain unchanged in this specific case, because timeElapsed will be 0.
            }
        }

        expect(newStabilityPoolSbrRewardDistributionStatus).to.equal(expectedNewSbrRewardDistributionStatus, 'SBRRewardDistributionStatus mismatch');
        expect(newStabilityPoolLastSBRRewardDistributedTime).to.equal(expectedNewStabilityPoolLastSBRRewardDistributedTime, 'StabilityPool.lastSBRRewardDistributedTime mismatch');
        expect(newStabilityPoolSbrRewardDistributionEndTime).to.equal(expectedNewStabilityPoolSbrRewardDistributionEndTime, 'StabilityPool.sbrRewardDistributionEndTime mismatch');
        expect(newStabilityPoolTotalSbrRewardPerToken).to.equal(expectedNewStabilityPoolTotalSbrRewardPerToken, 'StabilityPool.totalSbrRewardPerToken mismatch');
        expect(newStabilityPoolSbrRewardLoss).to.equal(expectedNewStabilityPoolSbrRewardLoss, 'StabilityPool.sbrRewardLoss mismatch');

        // SBRRewardsAdded event check
        // Event emitted if (totalStakedRaw > 0) && (timeElapsed > 0) and status is STARTED before _addSBRRewards
        const initialTimeElapsedBefore_addSBRRewards = (prevStabilityPoolSbrRewardDistributionStatus === 1n) ? (currentBlockTimestamp - prevStabilityPoolLastSBRRewardDistributedTime) : 0n;
        
        if (prevStabilityPoolSbrRewardDistributionStatus === 1n && 
            initialTimeElapsedBefore_addSBRRewards > 0n && 
            prevStabilityPoolTotalStakedRaw > 0n) {
            expect(sbrRewardsAddedEventFound, 'SBRRewardsAdded event not emitted').to.be.true;
            // sbrAddedRewardAmount is `sbrReward` in contract, which is `timeElapsed * sbrDistributionRate`
            const expectedSbrAddedRewardAmount = initialTimeElapsedBefore_addSBRRewards * prevSbrDistributionRate;
            expect(sbrAddedRewardAmount).to.equal(expectedSbrAddedRewardAmount, 'SBRRewardsAdded event rewardAmount mismatch');
        } else {
            expect(sbrRewardsAddedEventFound, 'SBRRewardsAdded event emitted unexpectedly').to.be.false;
        }

        // External Contract Interactions
        if (prevStabilityPoolTotalStakedRaw === 0n && prevStabilityPoolRewardSenderActive) {
            expect(newStableBaseCDPCanStabilityPoolReceiveRewards).to.be.true;
        } else {
            expect(newStableBaseCDPCanStabilityPoolReceiveRewards).to.equal(prevStableBaseCDPCanStabilityPoolReceiveRewards, 'StableBaseCDP.canStabilityPoolReceiveRewards should not change');
        }

        // DFIREToken totalSupply
        const expectedDFIRETotalSupplyIncrease = claimedSbrReward; 
        expect(newDFIRETokenTotalSupply).to.equal(prevDFIRETokenTotalSupply + expectedDFIRETotalSupplyIncrease, 'DFIREToken totalSupply mismatch');

        // Validate user's cumulativeProductScalingFactor and stakeResetCount
        expect(newStabilityPoolUserCumulativeProductScalingFactor).to.equal(newSnapshot.contractSnapshot.stabilityPool.stakeScalingFactor, 'User cumulativeProductScalingFactor mismatch');
        expect(newStabilityPoolUserStakeResetCount).to.equal(newSnapshot.contractSnapshot.stabilityPool.stakeResetCount, 'User stakeResetCount mismatch');

        return true; 
    }
}
