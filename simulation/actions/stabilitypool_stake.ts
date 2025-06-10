import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

class StakeAction extends Action {
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
        const dfidTokenContract = context.contracts.dfidToken as ethers.Contract;
        const actorBalance = currentSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);

        if (actorBalance <= BigInt(0)) {
            return [false, {}, {}];
        }

        // Generate a random amount within the actor's balance
        const _amount = BigInt(Math.floor(context.prng.next() % Number(actorBalance)));
        const frontend = ethers.ZeroAddress; // Or generate a random address if needed, but using zero address as default
        const fee = BigInt(0); // Setting fee to 0 as default. Can be randomized between 0 and BASIS_POINTS_DIVISOR from stabilityPool

        const allowance = await dfidTokenContract.allowance(actor.account.address, this.contract.target);
        console.log(`Allowance before stake: ${allowance}`);

        const canExecute = _amount > BigInt(0);

        const actionParams = {
            _amount: _amount,
            frontend: frontend,
            fee: fee,
        };

        return [canExecute, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { _amount, frontend, fee } = actionParams;
        try {
            console.log(`totalStakedRaw before stake: ${currentSnapshot.contractSnapshot.stabilityPool.totalStakedRaw}`)
            console.log(`User stake before stake: ${currentSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.stake || BigInt(0)}`)

            // Call the stake function using the contract instance passed in the constructor
            const tx = await this.contract.connect(actor.account.value).stake(_amount, frontend, fee);
            const receipt = await tx.wait();
            return receipt;
        } catch (error: any) {
            console.error("Transaction failed:", error);
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
        const { _amount } = actionParams;

        if (_amount <= BigInt(0)) {
            console.log("Skipping validation because _amount is zero.");
            return true;
        }

        // Accessing StabilityPool state from snapshots
        const previousUserStake = previousSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.stake || BigInt(0);
        const newUserStake = newSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.stake || BigInt(0);
        const previousTotalStakedRaw = previousSnapshot.contractSnapshot.stabilityPool.totalStakedRaw;
        const newTotalStakedRaw = newSnapshot.contractSnapshot.stabilityPool.totalStakedRaw;

        // Accessing DFIDToken state from snapshots
        const previousUserDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);
        const newUserDFIDBalance = newSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);
        const previousStabilityPoolDFIDBalance = previousSnapshot.contractSnapshot.dfidToken.balances[this.contract.target] || BigInt(0);
        const newStabilityPoolDFIDBalance = newSnapshot.contractSnapshot.dfidToken.balances[this.contract.target] || BigInt(0);

        const previousRewardSnapshot = previousSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.rewardSnapshot || BigInt(0);
        const newRewardSnapshot = newSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.rewardSnapshot || BigInt(0);
        const totalRewardPerToken = newSnapshot.contractSnapshot.stabilityPool.totalRewardPerToken;

        const previousCollateralSnapshot = previousSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.collateralSnapshot || BigInt(0);
        const newCollateralSnapshot = newSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.collateralSnapshot || BigInt(0);
        const totalCollateralPerToken = newSnapshot.contractSnapshot.stabilityPool.totalCollateralPerToken;

        const previousCumulativeProductScalingFactor = previousSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.cumulativeProductScalingFactor || BigInt(0);
        const newCumulativeProductScalingFactor = newSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.cumulativeProductScalingFactor || BigInt(0);
        const stakeScalingFactor = newSnapshot.contractSnapshot.stabilityPool.stakeScalingFactor;

        const previousStakeResetCount = previousSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.stakeResetCount || BigInt(0);
        const newStakeResetCount = newSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.stakeResetCount || BigInt(0);
        const stakeResetCount = newSnapshot.contractSnapshot.stabilityPool.stakeResetCount;

        const previousSBRRewardDistributionStatus = previousSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionStatus;
        const newSBRRewardDistributionStatus = newSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionStatus;

        // Validate state changes in StabilityPool
        expect(newUserStake).to.equal(previousUserStake + _amount, "User stake should increase by the staked amount.");
        expect(newTotalStakedRaw).to.equal(previousTotalStakedRaw + _amount, "Total staked raw should increase by the staked amount.");

        // Validate state changes in DFIDToken
        expect(newUserDFIDBalance).to.equal(previousUserDFIDBalance - _amount, "User's staking token balance should decrease by the staked amount.");
        expect(newStabilityPoolDFIDBalance).to.equal(previousStabilityPoolDFIDBalance + _amount, "StabilityPool's staking token balance should increase by the staked amount.");

        expect(newRewardSnapshot).to.equal(totalRewardPerToken, "The user's rewardSnapshot should be equal to totalRewardPerToken");
        expect(newCollateralSnapshot).to.equal(totalCollateralPerToken, "The user's collateralSnapshot should be equal to totalCollateralPerToken");
        expect(newCumulativeProductScalingFactor).to.equal(stakeScalingFactor, "The user's cumulativeProductScalingFactor should be equal to stakeScalingFactor");
        expect(newStakeResetCount).to.equal(stakeResetCount, "The user's stakeResetCount should be equal to stakeResetCount");

        // SBR reward validation - only validating if SBR rewards are active
        if (newSBRRewardDistributionStatus !== 'ENDED') {
            const previousSBRRewardSnapshot = previousSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[actor.account.address]?.rewardSnapshot || BigInt(0);
            const newSBRRewardSnapshot = newSnapshot.contractSnapshot.stabilityPool.sbrRewardSnapshots[actor.account.address]?.rewardSnapshot || BigInt(0);
            const totalSbrRewardPerToken = newSnapshot.contractSnapshot.stabilityPool.totalSbrRewardPerToken;
            expect(newSBRRewardSnapshot).to.equal(totalSbrRewardPerToken, "The user's SBR rewardSnapshot should be equal to totalSbrRewardPerToken");
        }

        // Verify that the Staked event is emitted with the correct user address and staked amount.
        const stakedEvent = executionReceipt.events.find((e) => e?.name === "Staked");
        expect(stakedEvent).to.not.be.undefined;
        expect(stakedEvent?.args?.account).to.equal(actor.account.address);
        expect(stakedEvent?.args?.amount).to.equal(_amount);

        console.log(`totalStakedRaw after stake: ${newSnapshot.contractSnapshot.stabilityPool.totalStakedRaw}`)
        console.log(`User stake after stake: ${newSnapshot.contractSnapshot.stabilityPool.userInfos[actor.account.address]?.stake || BigInt(0)}`)

        return true;
    }
}

export default StakeAction;
