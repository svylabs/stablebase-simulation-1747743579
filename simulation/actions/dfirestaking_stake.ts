import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from "chai";
import {ethers} from "ethers";

export class StakeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("StakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const actorAddress = actor.account.address;
        const dfireStakingContractAddress = context.contracts.dfireStaking.target;

        // Get actor's DFIREToken balance
        const actorDfireBalance = currentSnapshot.contractSnapshot.dfireToken.accounts[actorAddress]?.balance || 0n;

        // Get actor's allowance for DFIREStaking contract
        const dfireStakingAllowance = currentSnapshot.contractSnapshot.dfireToken.accounts[actorAddress]?.allowances[dfireStakingContractAddress] || 0n;

        // Determine the maximum amount that can be staked
        const maxAmount = actorDfireBalance < dfireStakingAllowance ? actorDfireBalance : dfireStakingAllowance;

        // If maxAmount is 0 or less, cannot stake
        if (maxAmount <= 0n) {
            return [false, {}, {}];
        }

        // Generate a random _amount between 1 and maxAmount
        // context.prng.next() returns a number between 0 and 2^32 - 1
        let _amount: bigint;
        if (maxAmount === 1n) {
            _amount = 1n;
        } else {
            // Generate a random number from 0 to maxAmount - 1, then add 1 to ensure it's > 0
            _amount = (BigInt(context.prng.next()) * maxAmount) / (2n**32n) + 1n;
            if (_amount > maxAmount) { // Handle potential floating point errors or edge cases
                _amount = maxAmount;
            }
            if (_amount === 0n) { // Ensure _amount is at least 1
                _amount = 1n;
            }
        }

        const actionParams = {_amount};

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value as ethers.Signer;
        const { _amount } = actionParams;

        const tx = await this.contract.connect(signer).stake(_amount);
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
        const actorAddress = actor.account.address;
        const dfireStakingContractAddress = context.contracts.dfireStaking.target;
        const dfireTokenContractAddress = context.contracts.dfireToken.target;
        const dfidTokenContractAddress = context.contracts.dfidToken.target;
        const stableBaseCDPContractAddress = context.contracts.stableBaseCDP.target;

        const { _amount } = actionParams;

        let validationPassed = true;

        // --- Event Validation ---
        let stakedEventFound = false;
        let claimedEventFound = false;
        let rewardAmount = 0n;
        let collateralReward = 0n;

        for (const log of executionReceipt.logs) {
            try {
                const parsedLog = this.contract.interface.parseLog(log);
                if (parsedLog.name === "Staked") {
                    expect(parsedLog.args.user).to.equal(actorAddress, "Staked event user mismatch");
                    expect(parsedLog.args.amount).to.equal(_amount, "Staked event amount mismatch");
                    stakedEventFound = true;
                } else if (parsedLog.name === "Claimed") {
                    expect(parsedLog.args.user).to.equal(actorAddress, "Claimed event user mismatch");
                    rewardAmount = parsedLog.args.rewardAmount;
                    collateralReward = parsedLog.args.collateralReward;
                    claimedEventFound = true;
                }
            } catch (error) {
                // Ignore logs not related to DFIREStaking contract
            }
        }

        expect(stakedEventFound).to.be.true("Staked event not emitted");
        expect(claimedEventFound).to.be.true("Claimed event not emitted");

        // --- State Validation: DFIREStaking Contract ---

        // user.stake update
        const prevUserStake = previousSnapshot.contractSnapshot.dfireStaking.userStake.stake;
        const newUserStake = newSnapshot.contractSnapshot.dfireStaking.userStake.stake;
        expect(newUserStake).to.equal(prevUserStake + _amount, "DFIREStaking user stake mismatch");

        // user.rewardSnapshot update
        const newRewardSnapshot = newSnapshot.contractSnapshot.dfireStaking.userStake.rewardSnapshot;
        const currentTotalRewardPerToken = newSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken; // Should be the value at _claim execution
        expect(newRewardSnapshot).to.equal(currentTotalRewardPerToken, "DFIREStaking reward snapshot mismatch");

        // user.collateralSnapshot update
        const newCollateralSnapshot = newSnapshot.contractSnapshot.dfireStaking.userStake.collateralSnapshot;
        const currentTotalCollateralPerToken = newSnapshot.contractSnapshot.dfireStaking.totalCollateralPerToken;
        expect(newCollateralSnapshot).to.equal(currentTotalCollateralPerToken, "DFIREStaking collateral snapshot mismatch");

        // totalStake update
        const prevTotalStake = previousSnapshot.contractSnapshot.dfireStaking.totalStake;
        const newTotalStake = newSnapshot.contractSnapshot.dfireStaking.totalStake;
        expect(newTotalStake).to.equal(prevTotalStake + _amount, "DFIREStaking total stake mismatch");

        // --- State Validation: DFIREToken (stakingToken) ---

        // msg.sender DFIREToken balance
        const prevActorDfireBalance = previousSnapshot.contractSnapshot.dfireToken.accounts[actorAddress].balance;
        const newActorDfireBalance = newSnapshot.contractSnapshot.dfireToken.accounts[actorAddress].balance;
        expect(newActorDfireBalance).to.equal(prevActorDfireBalance - _amount, "Actor DFIREToken balance mismatch");

        // DFIREStaking contract DFIREToken balance
        const prevStakingContractDfireBalance = previousSnapshot.contractSnapshot.dfireToken.accounts[dfireStakingContractAddress]?.balance || 0n;
        const newStakingContractDfireBalance = newSnapshot.contractSnapshot.dfireToken.accounts[dfireStakingContractAddress]?.balance || 0n;
        expect(newStakingContractDfireBalance).to.equal(prevStakingContractDfireBalance + _amount, "DFIREStaking contract DFIREToken balance mismatch");

        // allowance[msg.sender][DFIREStaking] update
        const prevAllowance = previousSnapshot.contractSnapshot.dfireToken.accounts[actorAddress].allowances[dfireStakingContractAddress];
        const newAllowance = newSnapshot.contractSnapshot.dfireToken.accounts[actorAddress].allowances[dfireStakingContractAddress];
        expect(newAllowance).to.equal(prevAllowance - _amount, "Allowance for DFIREStaking contract mismatch");

        // --- State Validation: DFIDToken (rewardToken) ---
        const prevActorDfidBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress];
        const newActorDfidBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[actorAddress];

        const prevStakingContractDfidBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[dfireStakingContractAddress];
        const newStakingContractDfidBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[dfireStakingContractAddress];

        if (rewardAmount > 0n) {
            expect(newActorDfidBalance).to.equal(prevActorDfidBalance + rewardAmount, "Actor DFIDToken balance mismatch");
            expect(newStakingContractDfidBalance).to.equal(prevStakingContractDfidBalance - rewardAmount, "DFIREStaking contract DFIDToken balance mismatch");
        } else {
            expect(newActorDfidBalance).to.equal(prevActorDfidBalance, "Actor DFIDToken balance should not change if reward is zero");
            expect(newStakingContractDfidBalance).to.equal(prevStakingContractDfidBalance, "DFIREStaking contract DFIDToken balance should not change if reward is zero");
        }

        // --- State Validation: Native ETH ---
        const prevActorEthBalance = previousSnapshot.accountSnapshot[actorAddress];
        const newActorEthBalance = newSnapshot.accountSnapshot[actorAddress];

        const prevStakingContractEthBalance = previousSnapshot.accountSnapshot[dfireStakingContractAddress];
        const newStakingContractEthBalance = newSnapshot.accountSnapshot[dfireStakingContractAddress];

        const gasUsed = executionReceipt.gasUsed;
        const effectiveGasPrice = executionReceipt.effectiveGasPrice;
        const gasCost = gasUsed * effectiveGasPrice;

        if (collateralReward > 0n) {
            expect(newActorEthBalance).to.equal(prevActorEthBalance + collateralReward - gasCost, "Actor ETH balance mismatch");
            expect(newStakingContractEthBalance).to.equal(prevStakingContractEthBalance - collateralReward, "DFIREStaking contract ETH balance mismatch");
        } else {
            expect(newActorEthBalance).to.equal(prevActorEthBalance - gasCost, "Actor ETH balance mismatch (no collateral reward)");
            expect(newStakingContractEthBalance).to.equal(prevStakingContractEthBalance, "DFIREStaking contract ETH balance should not change if collateral reward is zero");
        }

        // --- State Validation: StableBaseCDP ---
        const prevRewardSenderActive = previousSnapshot.contractSnapshot.dfireStaking.rewardSenderActive;
        const prevTotalStakeBeforeUpdate = previousSnapshot.contractSnapshot.dfireStaking.totalStake;
        const newSBRStakingPoolRewardsEnabled = newSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolRewardsEnabled;
        const prevSBRStakingPoolRewardsEnabled = previousSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolRewardsEnabled;

        if (prevRewardSenderActive && prevTotalStakeBeforeUpdate === 0n) {
            expect(newSBRStakingPoolRewardsEnabled).to.be.true("StableBaseCDP canSBRStakingPoolReceiveRewards should be true");
        } else {
            expect(newSBRStakingPoolRewardsEnabled).to.equal(prevSBRStakingPoolRewardsEnabled, "StableBaseCDP canSBRStakingPoolReceiveRewards should not change");
        }

        return validationPassed;
    }
}
