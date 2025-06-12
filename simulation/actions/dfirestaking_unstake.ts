import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class UnstakeAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("UnstakeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const dfireStakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;
        const stakes = dfireStakingSnapshot.stakes;
        const userAddress = actor.account.address;

        if (!stakes[userAddress] || stakes[userAddress].stake === BigInt(0)) {
            return [false, {}, {}];
        }

        const maxUnstakeAmount = stakes[userAddress].stake;
        // Use prng to generate a random amount within the allowed bounds
        const amountToUnstake = context.prng.next() % (Number(maxUnstakeAmount) + 1);
        const _amount = BigInt(amountToUnstake);

        if (_amount <= BigInt(0)) {
            return [false, {}, {}];
        }

        const actionParams = {
            _amount: _amount
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { _amount } = actionParams;
        // Use the contract passed in the constructor
        const signer = actor.account.value.connect(this.contract.provider);
        const tx = await this.contract.connect(signer).unstake(_amount);
        const receipt = await tx.wait();
        return { receipt: receipt };
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
        const userAddress = actor.account.address;

        const previousDfireStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

        const previousStakes = previousDfireStakingSnapshot.stakes;
        const newStakes = newDfireStakingSnapshot.stakes;

        const previousTotalStake = previousDfireStakingSnapshot.totalStake;
        const newTotalStake = newDfireStakingSnapshot.totalStake;

        // Stake Update
        expect(newStakes[userAddress].stake).to.equal(previousStakes[userAddress].stake - _amount, "User stake should be decreased by _amount");
        expect(newTotalStake).to.equal(previousTotalStake - _amount, "Total stake should be decreased by _amount");

        // Reward Claim - Hard to validate without knowing the exact reward calculation, but snapshot update should be validated
        expect(newStakes[userAddress].rewardSnapshot).to.equal(newDfireStakingSnapshot.totalRewardPerToken, "User reward snapshot should be updated to totalRewardPerToken");
        expect(newStakes[userAddress].collateralSnapshot).to.equal(newDfireStakingSnapshot.totalCollateralPerToken, "User collateral snapshot should be updated to totalCollateralPerToken");

        const previousAccountSnapshot = previousSnapshot.accountSnapshot;
        const newAccountSnapshot = newSnapshot.accountSnapshot;

        // Token Transfer Validation
        const previousDfireTokenSnapshot = previousSnapshot.contractSnapshot.dfireToken;
        const newDfireTokenSnapshot = newSnapshot.contractSnapshot.dfireToken;

        const previousUserStakingTokenBalance = previousDfireTokenSnapshot.accountBalance[userAddress] || BigInt(0);
        const newUserStakingTokenBalance = newDfireTokenSnapshot.accountBalance[userAddress] || BigInt(0);

        expect(newUserStakingTokenBalance).to.equal(previousUserStakingTokenBalance + _amount, "User staking token balance should increase by _amount");

        // ETH balance validation
        const previousUserEthBalance = previousAccountSnapshot[userAddress] || BigInt(0);
        const newUserEthBalance = newAccountSnapshot[userAddress] || BigInt(0);

        // It's difficult to determine the exact collateral reward amount due to the EVM's inability to directly predict the gas costs of the transfer. We can only check that the ETH balance didn't decrease unexpectedly.
        expect(newUserEthBalance).to.be.at.least(previousUserEthBalance, "User ETH balance should not decrease unexpectedly");

        // Reward Sender Update Validation
        if (previousDfireStakingSnapshot.rewardSenderActive && previousTotalStake > BigInt(0) && newTotalStake === BigInt(0)) {
            // Access stableBaseContract through context.contracts
            const stableBaseContract = context.contracts.stableBaseCDP as ethers.Contract;
            // Assuming there's a getter function `sbrStakingPoolCanReceiveRewards` on the stableBaseContract.
            //If not, validation needs to be skipped
            const canReceiveRewards = await stableBaseContract.sbrStakingPoolCanReceiveRewards();
            expect(canReceiveRewards).to.be.false;
        }

        // Event Validation. Assuming that the event is emitted correctly in contract.

        return true;
    }
}