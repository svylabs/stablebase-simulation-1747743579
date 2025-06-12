import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class ClaimAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("ClaimAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
        const userAddress = actor.account.address;
        const userInfo = stabilityPoolSnapshot.users[userAddress];

        if (!userInfo || userInfo.stake <= BigInt(0)) {
            return [false, {}, {}];
        }

        return [true, [], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        try {
            const tx = await this.contract.connect(actor.account.value).claim();
            const receipt = await tx.wait();
            return { receipt };
        } catch (error) {
            console.error("Claim execution failed:", error);
            throw error;
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
        const userAddress = actor.account.address;
        const previousStabilityPool = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPool = newSnapshot.contractSnapshot.stabilityPool;
        const previousDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;
        const previousDFIREToken = previousSnapshot.contractSnapshot.dfireToken;
        const newDFIREToken = newSnapshot.contractSnapshot.dfireToken;

        const previousUserInfo = previousStabilityPool.users[userAddress];
        const newUserInfo = newStabilityPool.users[userAddress];

        // Validate reward snapshot update
        expect(newUserInfo.rewardSnapshot).to.equal(newStabilityPool.totalRewardPerToken, "Reward snapshot should be updated");

        // Validate collateral snapshot update
        expect(newUserInfo.collateralSnapshot).to.equal(newStabilityPool.totalCollateralPerToken, "Collateral snapshot should be updated");

        //Validate cumulativeProductScalingFactor update
        expect(newUserInfo.cumulativeProductScalingFactor).to.equal(newStabilityPool.stakeScalingFactor, "cumulativeProductScalingFactor should be updated");

        //Validate stakeResetCount update
        expect(newUserInfo.stakeResetCount).to.equal(newStabilityPool.stakeResetCount, "stakeResetCount should be updated");

        const previousSBRRewardSnapshot = previousStabilityPool.sbrRewardSnapshots[userAddress];
        const newSBRRewardSnapshot = newStabilityPool.sbrRewardSnapshots[userAddress];

        // Assuming 2 represents the ENDED state, add a comment to explain.
        //sbrRewardDistributionStatus: 0 - NOT_STARTED, 1 - STARTED, 2 - ENDED
        if (newStabilityPool.sbrRewardDistributionStatus != 2) {
            // Validate SBR reward snapshot update
            expect(newSBRRewardSnapshot.rewardSnapshot).to.equal(newStabilityPool.totalSbrRewardPerToken, "SBR reward snapshot should be updated");
        } else if (
            previousSBRRewardSnapshot.status != 2
        ) {
            // Validate SBR reward status update
            expect(newSBRRewardSnapshot.status).to.equal(2, "SBR reward status should be CLAIMED");
        }

        const pendingRewardBefore = previousStabilityPool.userPendingReward[userAddress] || BigInt(0);
        const pendingCollateralBefore = previousStabilityPool.userPendingCollateral[userAddress] || BigInt(0);
        const pendingSbrRewardsBefore = previousStabilityPool.userPendingRewardAndCollateral[userAddress]?.[2] || BigInt(0);

        const BASIS_POINTS_DIVISOR = BigInt(10000);
        const rewardFee = (pendingRewardBefore * BASIS_POINTS_DIVISOR) / BASIS_POINTS_DIVISOR;
        const collateralFee = (pendingCollateralBefore * BASIS_POINTS_DIVISOR) / BASIS_POINTS_DIVISOR;
        const sbrFee = (pendingSbrRewardsBefore * BASIS_POINTS_DIVISOR) / BASIS_POINTS_DIVISOR;

        const expectedStakingTokenIncrease = pendingRewardBefore - rewardFee;
        const actualStakingTokenIncrease = (newDFIDToken.balances[userAddress] || BigInt(0)) - (previousDFIDToken.balances[userAddress] || BigInt(0));
        expect(actualStakingTokenIncrease).to.equal(expectedStakingTokenIncrease, "Staking token balance should increase by claimed amount");

        // Validate ETH balance change for user
        const expectedETHIncrease = pendingCollateralBefore - collateralFee;
        const actualETHIncrease = (newSnapshot.accountSnapshot[userAddress] || BigInt(0)) - (previousSnapshot.accountSnapshot[userAddress] || BigInt(0));
        expect(actualETHIncrease).to.equal(expectedETHIncrease, "ETH balance should increase by claimed amount");

        // Validate sbrToken balance change for user
        const expectedSBRTokenIncrease = pendingSbrRewardsBefore - sbrFee;
        const actualSBRTokenIncrease = (newDFIREToken.accountBalance[userAddress] || BigInt(0)) - (previousDFIREToken.accountBalance[userAddress] || BigInt(0));
        expect(actualSBRTokenIncrease).to.equal(expectedSBRTokenIncrease, "SBR token balance should increase by claimed amount");

        // Validate events
        const rewardClaimedEvent = executionReceipt.receipt.logs.find((log: any) => {
            try {
                const parsedLog = this.contract.interface.parseLog(log);
                return parsedLog && parsedLog.name === "RewardClaimed";
            } catch (e) {
                return false;
            }
        });

        if (rewardClaimedEvent) {
            const parsedLog = this.contract.interface.parseLog(rewardClaimedEvent);
            expect(parsedLog.args.user).to.equal(userAddress, "RewardClaimed event should have correct user");
            // Add more validation for reward, rewardFee, collateral, collateralFee if needed
        } else {
            expect.fail("RewardClaimed event was not emitted");
        }

        const dFireRewardClaimedEvent = executionReceipt.receipt.logs.find((log: any) => {
            try {
                const parsedLog = this.contract.interface.parseLog(log);
                return parsedLog && parsedLog.name === "DFireRewardClaimed";
            } catch (e) {
                return false;
            }
        });

        if (dFireRewardClaimedEvent) {
            const parsedLog = this.contract.interface.parseLog(dFireRewardClaimedEvent);
            expect(parsedLog.args.user).to.equal(userAddress, "DFireRewardClaimed event should have correct user");
            // Add more validation for sbrReward, sbrRewardFee if needed
        } // It's possible that this event is not emitted if there were no SBR rewards

        return true;
    }
}
