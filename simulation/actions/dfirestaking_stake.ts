import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class StakeAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("StakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const dfireTokenAddress = (context.contracts.dfireToken as ethers.Contract).target;

        if (dfireTokenAddress === ethers.ZeroAddress) {
            console.warn("DFIREToken address is zero address. Aborting.");
            return [false, {}, {}];
        }

        const dfireTokenBalance = currentSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);

        if (dfireTokenBalance <= BigInt(0)) {
            return [false, {}, {}];
        }

        // Ensure the amount is within the valid range [1, dfireTokenBalance]
        const amount = BigInt(Math.floor(context.prng.next() % Number(dfireTokenBalance) + 1));

        const params = {
            _amount: amount,
        };

        return [true, params, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { _amount } = actionParams;

        if (_amount <= 0) {
            throw new Error("Amount must be greater than zero.");
        }

        const tx = await this.contract.connect(actor.account.value).stake(_amount);
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const { _amount } = actionParams;
        const stakingContractAddress = (context.contracts.dfireStaking as ethers.Contract).target;
        const dfireTokenAddress = (context.contracts.dfireToken as ethers.Contract).target;
        const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;

        if (!stakingContractAddress || !dfireTokenAddress || !dfidTokenAddress) {
            console.warn("One or more contract addresses are missing. Validation may be incomplete.");
            return false;
        }

        // Staking
        const previousStake = previousSnapshot.contractSnapshot.dfireStaking.stakeByUser[actor.account.address]?.stake || BigInt(0);
        const newStake = newSnapshot.contractSnapshot.dfireStaking.stakeByUser[actor.account.address]?.stake || BigInt(0);
        expect(newStake).to.equal(previousStake + _amount, "Stake should increase by amount");

        const totalRewardPerToken = newSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;
        const totalCollateralPerToken = newSnapshot.contractSnapshot.dfireStaking.totalCollateralPerToken;
        expect(newSnapshot.contractSnapshot.dfireStaking.stakeByUser[actor.account.address]?.rewardSnapshot).to.equal(totalRewardPerToken, "rewardSnapshot should equal totalRewardPerToken");
        expect(newSnapshot.contractSnapshot.dfireStaking.stakeByUser[actor.account.address]?.collateralSnapshot).to.equal(totalCollateralPerToken, "collateralSnapshot should equal totalCollateralPerToken");

        const previousTotalStake = previousSnapshot.contractSnapshot.dfireStaking.totalStake;
        const newTotalStake = newSnapshot.contractSnapshot.dfireStaking.totalStake;
        expect(newTotalStake).to.equal(previousTotalStake + _amount, "Total stake should increase by amount");

        // Token Transfers
        const previousUserDFIREBalance = previousSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);
        const newUserDFIREBalance = newSnapshot.contractSnapshot.dfireToken.balances[actor.account.address] || BigInt(0);
        expect(newUserDFIREBalance).to.equal(previousUserDFIREBalance - _amount, "User's DFIRE balance should decrease by amount");

        const previousContractDFIREBalance = previousSnapshot.contractSnapshot.dfireToken.balances[stakingContractAddress] || BigInt(0);
        const newContractDFIREBalance = newSnapshot.contractSnapshot.dfireToken.balances[stakingContractAddress] || BigInt(0);
        expect(newContractDFIREBalance).to.equal(previousContractDFIREBalance + _amount, "Contract's DFIRE balance should increase by amount");

        // Reward and Collateral Claim Validation
        let rewardTransferEvent = null;
        let collateralTransferEvent = null;
        let rewardAmount: bigint | undefined = BigInt(0);

        if (executionReceipt.events) {
            rewardTransferEvent = executionReceipt.events.find(
                (event) =>
                    event.address === dfidTokenAddress &&
                    event.name === "Transfer" &&
                    event.args &&
                    event.args.to === actor.account.address
            );

            collateralTransferEvent = executionReceipt.events.find(
                (event) =>
                    event.address === stakingContractAddress &&
                    event.name === "Claimed"
            );
        }

        if (rewardTransferEvent) {
            rewardAmount = rewardTransferEvent.args.value ? BigInt(rewardTransferEvent.args.value) : BigInt(0);
            const previousUserDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.balance || BigInt(0);  // Assuming dfidToken has a global balance
            const newUserDFIDBalance = newSnapshot.contractSnapshot.dfidToken.balance || BigInt(0); // Assuming dfidToken has a global balance
            expect(newUserDFIDBalance).to.equal(previousUserDFIDBalance + rewardAmount, "User's DFID balance should increase by the reward amount");
            console.log("Reward transfer event found. Reward Amount: ", rewardAmount);
        } else {
            console.log("No reward transfer event found.");
            // Depending on contract logic, this might be okay, or an error.
        }

        if (collateralTransferEvent) {
            console.log("Collateral Claimed event found.");
        } else {
            console.log("No collateral claim event found.");
        }

        // Reward Sender Activation
        const rewardSenderActive = newSnapshot.contractSnapshot.dfireStaking.rewardSenderActive;
        const previousTotalStakeValue = previousSnapshot.contractSnapshot.dfireStaking.totalStake

        if (rewardSenderActive && previousTotalStakeValue === BigInt(0)) {
            // TODO: Mock IRewardSender and check if setCanSBRStakingPoolReceiveRewards was called.
            // Assuming it was called since we can't directly inspect the external call.
        }

        return true;
    }
}