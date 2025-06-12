import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from 'chai';
import {
    IStabilityPoolUserInfo,
    IStabilityPoolStakeResetSnapshot,
    StabilityPoolSnapshot,
    DFIDTokenContractSnapshot,
    DFIRETokenSnapshot,
    StableBaseCDPSnapshot
} from "../../../ilumina-artifacts/snapshot-types"; // Adjust path as necessary

// Constants from StabilityPool contract
const PRECISION = 10n**18n;

// Helper function to calculate effective stake based on contract logic
function _calculateEffectiveStake(
    user: IStabilityPoolUserInfo,
    stabilityPoolSnapshot: StabilityPoolSnapshot,
    stakeResetSnapshots: IStabilityPoolStakeResetSnapshot[]
): bigint {
    let effectiveStake = user.stake;

    if (user.cumulativeProductScalingFactor === 0n) {
        // This case might indicate an uninitialized user or an error state, based on contract logic.
        // If a user has no cumulativeProductScalingFactor, their stake might be 0 or uninitialized.
        // The contract's _getUserEffectiveStake has `if (user.cumulativeProductScalingFactor != 0) {`
        // so it won't proceed with calculation if it's 0.
        return 0n;
    }

    // Replicate _getUserEffectiveStake logic
    if (user.stakeResetCount === stabilityPoolSnapshot.stakeResetCount) {
        effectiveStake = (effectiveStake * stabilityPoolSnapshot.stakeScalingFactor * PRECISION) / user.cumulativeProductScalingFactor / PRECISION;
    } else {
        // Need to ensure the index for stakeResetSnapshots is valid
        if (Number(user.stakeResetCount) >= stakeResetSnapshots.length || user.stakeResetCount < 0n) {
            console.warn(`_calculateEffectiveStake: Invalid user.stakeResetCount index ${user.stakeResetCount}. Using 0n as effective stake.`);
            return 0n; 
        }
        const snapshot = stakeResetSnapshots[Number(user.stakeResetCount)];
        effectiveStake = (effectiveStake * snapshot.scalingFactor * PRECISION) / user.cumulativeProductScalingFactor / PRECISION;

        if (user.stakeResetCount + 1n !== stabilityPoolSnapshot.stakeResetCount) {
             if (Number(user.stakeResetCount + 1n) >= stakeResetSnapshots.length || user.stakeResetCount + 1n < 0n) {
                console.warn(`_calculateEffectiveStake: Invalid user.stakeResetCount + 1n index ${user.stakeResetCount + 1n}. Using 0n as effective stake.`);
                return 0n;
            }
            const nextSnapshot = stakeResetSnapshots[Number(user.stakeResetCount + 1n)];
            effectiveStake = (effectiveStake * nextSnapshot.scalingFactor) / PRECISION;
        } else {
            effectiveStake = (effectiveStake * stabilityPoolSnapshot.stakeScalingFactor) / PRECISION;
        }
    }
    return effectiveStake;
}

export class UnstakeAction extends Action {
    private contract: any; // Ethers.js Contract instance for StabilityPool

    constructor(contract: any) {
        super("UnstakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const userAddress = actor.account.address;
        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
        const userInfo = stabilityPoolSnapshot.users[userAddress];

        // Pre-execution validation rule: The 'amount' must be less than or equal to the current staked amount of the user.
        if (!userInfo || userInfo.stake === 0n) {
            context.log.info(`UnstakeAction: Actor ${userAddress} has no stake or user info not found. Cannot unstake.`);
            return [false, {}, {}];
        }

        const maxUnstakeAmount = userInfo.stake;
        // Generate a random amount between 1 and maxUnstakeAmount (inclusive)
        let amount: bigint;
        if (maxUnstakeAmount === 0n) {
            context.log.info(`UnstakeAction: Max unstake amount is 0. Cannot unstake.`);
            return [false, {}, {}];
        }
        
        // Ensure amount is positive and within bounds
        // context.prng.nextBigInt() returns a random BigInt value.
        // Modulo maxUnstakeAmount makes it [0, maxUnstakeAmount - 1], then add 1 to make it [1, maxUnstakeAmount].
        amount = (context.prng.nextBigInt() % maxUnstakeAmount) + 1n; 

        context.log.info(`UnstakeAction: Initializing unstake for ${userAddress} with amount: ${amount}. Max available: ${maxUnstakeAmount}`);

        return [true, { amount: amount }, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { amount } = actionParams;
        context.log.info(`Executing Unstake for ${actor.account.address} with amount: ${amount}`);
        
        // Connect signer to the contract and call the unstake function
        const tx = await this.contract.connect(actor.account.value).unstake(amount);
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
        const userAddress = actor.account.address;
        const { amount: unstakedAmount } = actionParams; // The amount parameter passed to unstake

        context.log.info(`Validating Unstake for ${userAddress} with unstaked amount: ${unstakedAmount}`);

        const prevStabilityPool = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPool = newSnapshot.contractSnapshot.stabilityPool;
        const prevDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;
        const prevDFIREToken = previousSnapshot.contractSnapshot.dfireToken;
        const newDFIREToken = newSnapshot.contractSnapshot.dfireToken;
        const prevStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;

        // --- Extract values from Events ---
        let rewardClaimedEventFound = false;
        let dFireRewardClaimedEventFound = false;
        let sbrRewardsAddedEventFound = false;
        let unstakedEventFound = false;

        let claimedReward = 0n;
        let claimedCollateral = 0n;
        let claimedSbrReward = 0n;
        let emittedUnstakedAmount = 0n; 

        // Find relevant events from the receipt
        for (const log of executionReceipt.logs) {
            try {
                // Try to parse the log with StabilityPool's interface
                const parsedLog = this.contract.interface.parseLog(log);
                if (parsedLog.name === "Unstaked") {
                    unstakedEventFound = true;
                    expect(parsedLog.args.user).to.equal(userAddress, "Unstaked event user mismatch");
                    emittedUnstakedAmount = BigInt(parsedLog.args.amount.toString());
                    expect(emittedUnstakedAmount).to.equal(unstakedAmount, "Unstaked event amount mismatch");
                } else if (parsedLog.name === "RewardClaimed") {
                    rewardClaimedEventFound = true;
                    expect(parsedLog.args.user).to.equal(userAddress, "RewardClaimed event user mismatch");
                    // Frontend fee is 0 because the unstake function calls unstake(amount, msg.sender, 0)
                    expect(BigInt(parsedLog.args.rewardFrontendFee.toString())).to.equal(0n, "RewardClaimed event rewardFrontendFee not 0");
                    expect(BigInt(parsedLog.args.collateralFrontendFee.toString())).to.equal(0n, "RewardClaimed event collateralFrontendFee not 0");
                    claimedReward = BigInt(parsedLog.args.totalReward.toString());
                    claimedCollateral = BigInt(parsedLog.args.totalCollateral.toString());
                } else if (parsedLog.name === "DFireRewardClaimed") {
                    dFireRewardClaimedEventFound = true;
                    expect(parsedLog.args.user).to.equal(userAddress, "DFireRewardClaimed event user mismatch");
                    // Frontend fee is 0
                    expect(BigInt(parsedLog.args.frontendFee.toString())).to.equal(0n, "DFireRewardClaimed event frontendFee not 0");
                    claimedSbrReward = BigInt(parsedLog.args.amount.toString());
                } else if (parsedLog.name === "SBRRewardsAdded") {
                    sbrRewardsAddedEventFound = true;
                }
            } catch (error) {
                // Ignore logs that don't match StabilityPool interface or are not recognized
            }
        }
        expect(unstakedEventFound, "Unstaked event not found").to.be.true;
        expect(rewardClaimedEventFound, "RewardClaimed event not found").to.be.true;
        // DFireRewardClaimed event is conditional
        if (claimedSbrReward > 0n) {
            expect(dFireRewardClaimedEventFound, "DFireRewardClaimed event not found despite sbrReward > 0").to.be.true;
        } else {
            expect(dFireRewardClaimedEventFound, "DFireRewardClaimed event found despite sbrReward = 0").to.be.false;
        }


        // --- Calculate Gas Fees ---
        const gasUsed = BigInt(executionReceipt.gasUsed.toString());
        const gasPrice = BigInt(executionReceipt.gasPrice.toString());
        const gasFee = gasUsed * gasPrice;

        // --- Validate StabilityPool Contract State ---

        // 1. users[msg.sender].stake
        // Get previous user info. initialize() ensures it exists and has stake.
        const prevUserInfo = prevStabilityPool.users[userAddress];
        
        // Calculate effective stake *before* the unstake amount is subtracted, 
        // as the contract first updates the stake to its effective value, then subtracts.
        const effectiveStakeAfterClaimUpdatesBeforeUnstakeAmount = _calculateEffectiveStake(
            prevUserInfo, // Represents user's state before this transaction
            prevStabilityPool,
            prevStabilityPool.stakeResetSnapshots
        );
        
        // The final user stake should be the effective stake (after updates by _updateUserStake) minus the unstaked amount
        const expectedNewUserStake = effectiveStakeAfterClaimUpdatesBeforeUnstakeAmount - unstakedAmount;
        expect(newStabilityPool.users[userAddress]?.stake, `New user stake mismatch for ${userAddress}`).to.equal(expectedNewUserStake);
        
        // 2. totalStakedRaw
        const expectedNewTotalStakedRaw = prevStabilityPool.totalStakedRaw - unstakedAmount;
        expect(newStabilityPool.totalStakedRaw, "totalStakedRaw mismatch").to.equal(expectedNewTotalStakedRaw);

        // 3. rewardSnapshot, collateralSnapshot, cumulativeProductScalingFactor, stakeResetCount
        const newUserInfo = newStabilityPool.users[userAddress];
        expect(newUserInfo?.rewardSnapshot, "rewardSnapshot mismatch").to.equal(newStabilityPool.totalRewardPerToken);
        expect(newUserInfo?.collateralSnapshot, "collateralSnapshot mismatch").to.equal(newStabilityPool.totalCollateralPerToken);
        expect(newUserInfo?.cumulativeProductScalingFactor, "cumulativeProductScalingFactor mismatch").to.equal(newStabilityPool.stakeScalingFactor);
        expect(newUserInfo?.stakeResetCount, "stakeResetCount mismatch").to.equal(newStabilityPool.stakeResetCount);

        // 4. sbrRewardSnapshots[msg.sender].rewardSnapshot
        // SBRRewardDistribution.ENDED is 2n, so if status is not ENDED, then rewardSnapshot is updated
        if (prevStabilityPool.sbrRewardDistributionStatus !== 2n) {
            expect(newStabilityPool.sbrRewardSnapshots[userAddress]?.rewardSnapshot, "sbrRewardSnapshots.rewardSnapshot mismatch").to.equal(newStabilityPool.totalSbrRewardPerToken);
        }

        // 5. sbrRewardSnapshots[msg.sender].status
        // SBRRewardDistribution.CLAIMED is 2n
        const prevSbrSnapshot = prevStabilityPool.sbrRewardSnapshots[userAddress];
        const prevSbrStatus = prevSbrSnapshot ? prevSbrSnapshot.status : 0n; // Default to NOT_STARTED (0n) if no prior snapshot

        if (prevStabilityPool.sbrRewardDistributionStatus === 2n /* ENDED */ && prevSbrStatus !== 2n /* CLAIMED */) {
            expect(newStabilityPool.sbrRewardSnapshots[userAddress]?.status, "sbrRewardSnapshots.status mismatch (should be CLAIMED)").to.equal(2n);
        } else {
            // If SBR was not ended or already claimed, status should persist (or default to NOT_STARTED if never interacted)
            expect(newStabilityPool.sbrRewardSnapshots[userAddress]?.status, "sbrRewardSnapshots.status mismatch (should not change or be default)").to.equal(prevSbrStatus);
        }

        // 6. stableBaseCDP.canStabilityPoolReceiveRewards
        if (prevStabilityPool.totalStakedRaw > 0n && newStabilityPool.totalStakedRaw === 0n && prevStabilityPool.rewardSenderActive === true) {
            expect(newStableBaseCDP.stabilityPoolRewardsEnabled, "StableBaseCDP.stabilityPoolRewardsEnabled should be false").to.be.false;
        } else {
            expect(newStableBaseCDP.stabilityPoolRewardsEnabled, "StableBaseCDP.stabilityPoolRewardsEnabled should not change").to.equal(prevStableBaseCDP.stabilityPoolRewardsEnabled);
        }

        // --- Validate Token Balances ---

        // DFIDToken (staking token)
        // msg.sender DFIDToken balance: increases by unstaked amount + claimed reward (no fee)
        const expectedUserDFIDBalance = (prevDFIDToken.accountBalances[userAddress] || 0n) + unstakedAmount + claimedReward;
        expect(newDFIDToken.accountBalances[userAddress], `User ${userAddress} DFIDToken balance mismatch`).to.equal(expectedUserDFIDBalance);

        // StabilityPool DFIDToken balance: decreases by unstaked amount + claimed reward (transferred out)
        const expectedPoolDFIDBalance = (prevDFIDToken.accountBalances[context.contracts.stabilityPool.target] || 0n) - unstakedAmount - claimedReward;
        expect(newDFIDToken.accountBalances[context.contracts.stabilityPool.target], `StabilityPool DFIDToken balance mismatch`).to.equal(expectedPoolDFIDBalance);

        // DFIREToken (SBR token)
        // msg.sender DFIREToken balance: increases by claimed SBR reward (no fee)
        const expectedUserDFIREBalance = (prevDFIREToken.accounts[userAddress]?.balance || 0n) + claimedSbrReward;
        expect(newDFIREToken.accounts[userAddress]?.balance, `User ${userAddress} DFIREToken balance mismatch`).to.equal(expectedUserDFIREBalance);

        // DFIREToken total supply: increases by claimed SBR reward
        const expectedDFIRETotalSupply = prevDFIREToken.tokenTotalSupply + claimedSbrReward;
        expect(newDFIREToken.tokenTotalSupply, "DFIREToken total supply mismatch").to.equal(expectedDFIRETotalSupply);

        // --- Validate Native Currency Balance ---
        // msg.sender ETH balance: increases by claimed collateral minus gas fee
        const expectedUserEthBalance = (previousSnapshot.accountSnapshot[userAddress] || 0n) - gasFee + claimedCollateral;
        expect(newSnapshot.accountSnapshot[userAddress], `User ${userAddress} ETH balance mismatch`).to.equal(expectedUserEthBalance);

        // --- Validate Events ---
        // Unstaked, RewardClaimed, DFireRewardClaimed events already checked at the top.

        // SBRRewardsAdded event is conditional: only if was STARTED and totalStakedRaw > 0
        const shouldHaveEmittedSBRRewardsAdded = (
            prevStabilityPool.sbrRewardDistributionStatus === 1n /* STARTED */ && 
            prevStabilityPool.totalStakedRaw > 0n
        );        
        expect(sbrRewardsAddedEventFound, "SBRRewardsAdded event emission mismatch").to.equal(shouldHaveEmittedSBRRewardsAdded);
        

        // Check for ERC20 Transfer events (DFIDToken and DFIREToken)
        let dfidTransferToUserFound = false;
        let dfireMintToUserFound = false;

        for (const log of executionReceipt.logs) {
            // Check DFIDToken Transfer events
            if (log.address.toLowerCase() === context.contracts.dfidToken.target.toLowerCase()) {
                try {
                    const parsedLog = context.contracts.dfidToken.interface.parseLog(log);
                    if (parsedLog.name === "Transfer") {
                        // Transfer from StabilityPool to user for unstaked amount and reward
                        if (parsedLog.args.from.toLowerCase() === context.contracts.stabilityPool.target.toLowerCase() && 
                            parsedLog.args.to.toLowerCase() === userAddress.toLowerCase()) {
                            if (BigInt(parsedLog.args.value.toString()) === unstakedAmount + claimedReward) {
                                dfidTransferToUserFound = true;
                            }
                        }
                    }
                } catch (error) { /* ignore parse errors for other events */ }
            }
            // Check DFIREToken Transfer events (minting emits Transfer from address(0))
            if (log.address.toLowerCase() === context.contracts.dfireToken.target.toLowerCase()) {
                try {
                    const parsedLog = context.contracts.dfireToken.interface.parseLog(log);
                    if (parsedLog.name === "Transfer") {
                        if (parsedLog.args.from.toLowerCase() === "0x0000000000000000000000000000000000000000" && 
                            parsedLog.args.to.toLowerCase() === userAddress.toLowerCase()) {
                            if (BigInt(parsedLog.args.value.toString()) === claimedSbrReward) {
                                dfireMintToUserFound = true;
                            }
                        }
                    }
                } catch (error) { /* ignore parse errors for other events */ }
            }
        }
        expect(dfidTransferToUserFound, "DFIDToken Transfer to user for unstaked amount + reward not found").to.be.true;
        if (claimedSbrReward > 0n) { // Only expect mint if there were SBR rewards
            expect(dfireMintToUserFound, "DFIREToken mint to user for SBR rewards not found").to.be.true;
        } else {
            expect(dfireMintToUserFound, "DFIREToken mint to user found unexpectedly when no SBR rewards claimed").to.be.false;
        }


        context.log.info("UnstakeAction validation successful!");
        return true;
    }
}
