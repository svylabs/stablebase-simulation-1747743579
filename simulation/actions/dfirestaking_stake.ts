import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {ethers} from "ethers";
import {expect} from "chai";

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
        const dfireTokenSnapshot = currentSnapshot.contractSnapshot.dfireToken;
        const accountAddress = actor.account.address;
        const accountBalance = dfireTokenSnapshot.accountBalance[accountAddress] || BigInt(0);

        if (accountBalance <= BigInt(0)) {
            return [false, {}, {}];
        }

        // Generate a random amount to stake, but ensure it's within the account's balance
        const maxStakeAmount = accountBalance;
        const amountToStake = BigInt(context.prng.next()) % (maxStakeAmount + BigInt(1)); // Ensure non-zero stake
        if (amountToStake <= BigInt(0)) {
          return [false, {}, {}];
        }

        const params = {
            _amount: amountToStake,
        };

        return [true, params, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value.connect(this.contract.provider);
        const contractWithSigner = this.contract.connect(signer);
        const tx = await contractWithSigner.stake(actionParams._amount);
        return {receipt: await tx.wait(), rawResponse: tx};
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const amountStaked = actionParams._amount;
        const actorAddress = actor.account.address;
        const stakingContractAddress = this.contract.target;

        // Get previous and new snapshots for relevant contracts
        const prevDfireStaking = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStaking = newSnapshot.contractSnapshot.dfireStaking;
        const prevDfireToken = previousSnapshot.contractSnapshot.dfireToken;
        const newDfireToken = newSnapshot.contractSnapshot.dfireToken;
        const prevDfidToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidToken = newSnapshot.contractSnapshot.dfidToken;
        const prevAccountBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);

        const initialUserStake = prevDfireStaking.stakes[actorAddress]?.stake || BigInt(0);
        const newUserStake = newDfireStaking.stakes[actorAddress]?.stake || BigInt(0);

        const initialTotalStake = prevDfireStaking.totalStake;
        const newTotalStake = newDfireStaking.totalStake;

        const initialStakingTokenBalance = prevDfireToken.accountBalance[stakingContractAddress] || BigInt(0);
        const newStakingTokenBalance = newDfireToken.accountBalance[stakingContractAddress] || BigInt(0);

        const initialUserTokenBalance = prevDfireToken.accountBalance[actorAddress] || BigInt(0);
        const newUserTokenBalance = newDfireToken.accountBalance[actorAddress] || BigInt(0);

        const initialUserRewardBalance = prevDfidToken.balances[actorAddress] || BigInt(0);
        const newUserRewardBalance = newDfidToken.balances[actorAddress] || BigInt(0);

        // User stake balance should increase by amountStaked
        expect(newUserStake).to.be.equal(initialUserStake + amountStaked, "User stake balance not updated correctly");

        // Total stake should increase by amountStaked
        expect(newTotalStake).to.be.equal(initialTotalStake + amountStaked, "Total stake not updated correctly");

        // Staking token balance of contract should increase by amountStaked
        expect(newStakingTokenBalance).to.be.equal(initialStakingTokenBalance + amountStaked, "Staking contract token balance not updated correctly");

        // User's token balance should decrease by amountStaked
        expect(newUserTokenBalance).to.be.equal(initialUserTokenBalance - amountStaked, "User's token balance not updated correctly");

        // Check reward claim and collateral claim
        const reward = newUserRewardBalance - initialUserRewardBalance;
        const collateralReward = newAccountBalance - prevAccountBalance;

        // Check if claimed event is emitted
        const claimedEvent = executionReceipt.receipt.logs.find(
            (log: any) => {
                try {
                    const parsedLog = this.contract.interface.parseLog(log);
                    return parsedLog.name === "Claimed" && parsedLog.args.user === actorAddress && parsedLog.args.reward === reward && parsedLog.args.collateralReward === collateralReward;
                } catch (e) {
                    return false;
                }
            }
        );

        // Staked event should be emitted with the correct parameters
        const stakedEvent = executionReceipt.receipt.logs.find(
            (log: any) => {
                try {
                    const parsedLog = this.contract.interface.parseLog(log);
                    return parsedLog.name === "Staked" && parsedLog.args.user === actorAddress && parsedLog.args.amount === amountStaked;
                } catch (e) {
                    return false;
                }
            }
        );
        expect(stakedEvent).to.not.be.undefined;

        //check IRewardSender(stableBaseContract)
        if (newDfireStaking.rewardSenderActive && initialTotalStake === BigInt(0)){
          //Need to find a way to validate the call to stableBaseContract.setCanSBRStakingPoolReceiveRewards(true)
          //It can be validated by checking if stableBaseCDP.sbrStakingPoolCanReceiveRewards is true in the new snapshot
          expect(newSnapshot.contractSnapshot.stableBaseCDP.sbrStakingPoolCanReceiveRewards).to.be.true;
        }

        expect(claimedEvent).to.not.be.undefined;

        return true;
    }
}
