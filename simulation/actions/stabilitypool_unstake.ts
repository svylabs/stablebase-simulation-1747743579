import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { expect } from 'chai';
import { ethers } from 'ethers';

export class UnstakeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("UnstakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
        const userAddress = actor.account.address;
        const userStake = stabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);

        if (userStake <= BigInt(0)) {
            return [false, {}, {}]; // Cannot unstake if stake is zero or negative
        }

        // Generate a random amount to unstake, but not more than the current stake
        const maxUnstakeAmount = userStake;
        const unstakeAmount = BigInt(context.prng.next()) % (maxUnstakeAmount + BigInt(1)); // Ensure amount is between 0 and maxUnstakeAmount (inclusive).
        if (unstakeAmount <= BigInt(0)) {
            return [false, {}, {}]; // Cannot unstake if amount is zero.
        }

        // Generate a random frontend address
        const frontendAddress = ethers.Wallet.createRandom().address;

        // Generate a random fee between 0 and 1000 (10%)
        const fee = BigInt(context.prng.next()) % BigInt(1001);

        const actionParams = {
            amount: unstakeAmount,
            frontend: frontendAddress,
            fee: fee
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { amount, frontend, fee } = actionParams;
        const tx = await this.contract.connect(actor.account.value).unstake(amount, frontend, fee);
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
        const { amount, frontend, fee } = actionParams;
        const userAddress = actor.account.address;

        const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
        const previousDFIRETokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
        const newDFIRETokenSnapshot = newSnapshot.contractSnapshot.dfireToken;

        const previousUserStake = previousStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);
        const newUserStake = newStabilityPoolSnapshot.users[userAddress]?.stake || BigInt(0);
        const previousTotalStakedRaw = previousStabilityPoolSnapshot.totalStakedRaw;
        const newTotalStakedRaw = newStabilityPoolSnapshot.totalStakedRaw;

        const previousDFIDTokenBalance = previousDFIDTokenSnapshot.balances[userAddress] || BigInt(0);
        const newDFIDTokenBalance = newDFIDTokenSnapshot.balances[userAddress] || BigInt(0);

        const previousStakingTokenContractBalance = previousDFIDTokenSnapshot.balances[this.contract.target] || BigInt(0);
        const newStakingTokenContractBalance = newDFIDTokenSnapshot.balances[this.contract.target] || BigInt(0);

        // Stake Updates
        expect(newUserStake, "User's stake should decrease by _amount").to.equal(previousUserStake - amount);
        expect(newUserStake, "User's stake should be non-negative").to.be.at.least(BigInt(0));
        expect(newTotalStakedRaw, "totalStakedRaw should decrease by _amount").to.equal(previousTotalStakedRaw - amount);
        expect(newTotalStakedRaw, "totalStakedRaw should be non-negative").to.be.at.least(BigInt(0));

        // Token Transfer
        expect(newDFIDTokenBalance, "msg.sender should receive _amount of the stakingToken.").to.equal(previousDFIDTokenBalance + amount);
        expect(newStakingTokenContractBalance, "Contract staking token balance should decrease").to.equal(previousStakingTokenContractBalance - amount);

        // totalStakedRaw == 0 condition
        if (previousTotalStakedRaw > BigInt(0) && newTotalStakedRaw === BigInt(0)) {
            const stableBaseCDP = context.contracts.stableBaseCDP;
            if (stableBaseCDP) {
                const iface = stableBaseCDP.interface;
                const setCanStabilityPoolReceiveRewardsEvent = executionReceipt.receipt.logs.find(
                    (log) => {
                        try {
                            const parsedLog = iface.parseLog(log);
                            return parsedLog && parsedLog.name === 'SetCanStabilityPoolReceiveRewards';
                        } catch (e) {
                            return false;
                        }
                    }
                );

                expect(setCanStabilityPoolReceiveRewardsEvent).to.not.be.undefined;
            }
        }

        // Reward snapshot validations
        const previousUserRewardSnapshot = previousStabilityPoolSnapshot.users[userAddress]?.rewardSnapshot || BigInt(0);
        const newUserRewardSnapshot = newStabilityPoolSnapshot.users[userAddress]?.rewardSnapshot || BigInt(0);

        const previousUserCollateralSnapshot = previousStabilityPoolSnapshot.users[userAddress]?.collateralSnapshot || BigInt(0);
        const newUserCollateralSnapshot = newStabilityPoolSnapshot.users[userAddress]?.collateralSnapshot || BigInt(0);

        const previousUserSBRRewardSnapshot = previousStabilityPoolSnapshot.sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0);
        const newUserSBRRewardSnapshot = newStabilityPoolSnapshot.sbrRewardSnapshots[userAddress]?.rewardSnapshot || BigInt(0);

        //cumulativeProductScalingFactor and stakeResetCount validations
         const previousCumulativeProductScalingFactor = previousStabilityPoolSnapshot.users[userAddress]?.cumulativeProductScalingFactor || BigInt(0);
         const newCumulativeProductScalingFactor = newStabilityPoolSnapshot.users[userAddress]?.cumulativeProductScalingFactor || BigInt(0);
         const previousStakeResetCount = previousStabilityPoolSnapshot.users[userAddress]?.stakeResetCount || BigInt(0);
         const newStakeResetCount = newStabilityPoolSnapshot.users[userAddress]?.stakeResetCount || BigInt(0);

         expect(newCumulativeProductScalingFactor, "cumulativeProductScalingFactor should be updated").to.equal(newStabilityPoolSnapshot.stakeScalingFactor);
         expect(newStakeResetCount, "stakeResetCount should be updated").to.equal(newStabilityPoolSnapshot.stakeResetCount);

        // Additional validations for reward, collateral, and SBR reward updates would go here.
        const rewardClaimedEvent = executionReceipt.receipt.logs.find(
            (log) => {
                try {
                    const iface = this.contract.interface;
                    const parsedLog = iface.parseLog(log);
                    return parsedLog && parsedLog.name === 'RewardClaimed';
                } catch (e) {
                    return false;
                }
            }
        );

        if (rewardClaimedEvent) {
            const iface = this.contract.interface;
            const parsedLog = iface.parseLog(rewardClaimedEvent);

            // Example: Validate reward values
            // expect(parsedLog.args.reward).to.be.above(BigInt(0));
        }

        // Account balance validations
        const previousAccountBalance = previousSnapshot.accountSnapshot[userAddress] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[userAddress] || BigInt(0);

        return true;
    }
}
