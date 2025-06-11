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
        const dfireStakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
        const stakeInfo = dfireStakingSnapshot.stakes[actor.account.address];

        if (!stakeInfo || stakeInfo.stake === BigInt(0)) {
            return [false, {}, {}]; // User has no stake
        }

        const canExecuteReward = dfireStakingSnapshot.totalRewardPerTokenValue > stakeInfo.rewardSnapshot;
        const canExecuteCollateral = dfireStakingSnapshot.totalCollateralPerTokenValue > stakeInfo.collateralSnapshot;

        if (!canExecuteReward && !canExecuteCollateral) {
          return [false, {}, {}];
        }

        // No parameters needed for claim function
        return [true, [], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const tx = await this.contract.connect(actor.account.value).claim();
        const receipt = await tx.wait();
        return { receipt };
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const previousStakeInfo = previousDFIREStakingSnapshot.stakes[actor.account.address];
        const newStakeInfo = newDFIREStakingSnapshot.stakes[actor.account.address];

        const previousRewardTokenBalance = previousDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);
        const newRewardTokenBalance = newDFIDTokenSnapshot.balances[actor.account.address] || BigInt(0);

        const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newEthBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        const totalRewardPerToken = newDFIREStakingSnapshot.totalRewardPerTokenValue;
        const totalCollateralPerToken = newDFIREStakingSnapshot.totalCollateralPerTokenValue;
        const stake = previousStakeInfo.stake;
        const PRECISION = previousDFIREStakingSnapshot.precisionValue;

        const expectedReward = ((totalRewardPerToken - previousStakeInfo.rewardSnapshot) * stake) / PRECISION;
        const expectedCollateralReward = ((totalCollateralPerToken - previousStakeInfo.collateralSnapshot) * stake) / PRECISION;

        const actualRewardIncrease = newRewardTokenBalance - previousRewardTokenBalance;
        const ethBalanceChange = newEthBalance - previousEthBalance;

        expect(newStakeInfo.rewardSnapshot).to.equal(totalRewardPerToken, "Reward snapshot should be updated to totalRewardPerToken");
        expect(newStakeInfo.collateralSnapshot).to.equal(totalCollateralPerToken, "Collateral snapshot should be updated to totalCollateralPerToken");

        if (expectedReward > BigInt(0)) {
            expect(actualRewardIncrease).to.equal(expectedReward, "Reward token balance should increase by the expected reward amount");
        }

        if(expectedCollateralReward > BigInt(0)){
            expect(ethBalanceChange).to.equal(expectedCollateralReward, "ETH balance should increase by the expected collateral reward amount");
        }

        expect(newDFIREStakingSnapshot.totalRewardPerTokenValue).to.equal(previousDFIREStakingSnapshot.totalRewardPerTokenValue, "totalRewardPerToken should remain unchanged");
        expect(newDFIREStakingSnapshot.totalCollateralPerTokenValue).to.equal(previousDFIREStakingSnapshot.totalCollateralPerTokenValue, "totalCollateralPerToken should remain unchanged");
        expect(newDFIREStakingSnapshot.totalStakeValue).to.equal(previousDFIREStakingSnapshot.totalStakeValue, "totalStake should remain unchanged");

        // Check for Claimed event emission
        const claimedEvent = executionReceipt.receipt.logs.find((log: any) => {
            try {
                const parsedLog = this.contract.interface.parseLog(log);
                return parsedLog.name === "Claimed";
            } catch (e) {
                return false;
            }
        });

        if (claimedEvent) {
            const parsedLog = this.contract.interface.parseLog(claimedEvent);
            expect(parsedLog.args.user).to.equal(actor.account.address, "Claimed event should emit the correct user address");
            expect(parsedLog.args.reward).to.equal(expectedReward, "Claimed event should emit the correct reward amount");
            expect(parsedLog.args.collateralReward).to.equal(expectedCollateralReward, "Claimed event should emit the correct collateral reward amount");
        }

        return true;
    }
}
