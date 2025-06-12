import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {ethers} from "ethers";
import {expect} from 'chai';

class ClaimAction extends Action {
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

        const userStake = dfireStakingSnapshot?.userStake;
        const userPendingRewards = dfireStakingSnapshot?.userPendingRewards;

        const hasStake = userStake && userStake.stake > 0n;
        const hasPendingClaimableRewards = userPendingRewards && (userPendingRewards.pendingRewardAmount > 0n || userPendingRewards.pendingCollateralReward > 0n);

        if (hasStake && hasPendingClaimableRewards) {
            return [true, {}, {}];
        }

        return [false, {}, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value as ethers.Signer;
        const connectedContract = this.contract.connect(signer);

        const tx = await connectedContract.claim();
        const receipt = await tx.wait();

        if (!receipt) {
            throw new Error("Transaction receipt is null or undefined.");
        }

        return {
            transactionHash: receipt.hash,
            blockNumber: BigInt(receipt.blockNumber),
            gasUsed: BigInt(receipt.gasUsed),
            cumulativeGasUsed: BigInt(receipt.cumulativeGasUsed),
            gasPrice: BigInt(tx.gasPrice || 0),
            effectiveGasPrice: BigInt(receipt.effectiveGasPrice || 0),
            events: receipt.logs.map(log => ({
                topics: log.topics,
                data: log.data,
                address: log.address,
                logIndex: BigInt(log.logIndex),
                blockHash: log.blockHash,
                blockNumber: BigInt(log.blockNumber),
                transactionHash: log.transactionHash,
                transactionIndex: BigInt(log.transactionIndex),
                eventName: '',
                args: []
            })),
            transactionIndex: BigInt(receipt.transactionIndex),
            from: receipt.from,
            to: receipt.to || '',
            status: receipt.status === 1,
            logsBloom: receipt.logsBloom,
            type: BigInt(receipt.type || 0),
            contractAddress: receipt.contractAddress || null
        };
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
        const dfireStakingContractAddress = this.contract.target as string;
        const dfidTokenContract = context.contracts.dfidToken as ethers.Contract;
        const dfidTokenContractAddress = dfidTokenContract.target as string;

        const prevDfireStaking = previousSnapshot.contractSnapshot.dfireStaking;
        const newDfireStaking = newSnapshot.contractSnapshot.dfireStaking;

        const prevDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;

        const prevActorETHBalance = previousSnapshot.accountSnapshot[actorAddress];
        const newActorETHBalance = newSnapshot.accountSnapshot[actorAddress];
        const prevDFIREStakingETHBalance = previousSnapshot.accountSnapshot[dfireStakingContractAddress];
        const newDFIREStakingETHBalance = newSnapshot.accountSnapshot[dfireStakingContractAddress];

        const gasCost = executionReceipt.gasUsed * executionReceipt.effectiveGasPrice;

        let rewardAmount: bigint = 0n;
        let collateralReward: bigint = 0n;

        try {
            const claimedEvent = executionReceipt.events.find(event => {
                try {
                    const decodedEvent = this.contract.interface.parseLog(event);
                    return decodedEvent?.name === "Claimed";
                } catch (e) {
                    return false;
                }
            });

            expect(claimedEvent, "Claimed event must be emitted.").to.exist;

            const decodedClaimedEvent = this.contract.interface.parseLog(claimedEvent!);
            const eventArgs = decodedClaimedEvent!.args;

            expect(eventArgs.user.toLowerCase(), "Claimed event: 'user' must be msg.sender.").to.equal(actorAddress.toLowerCase());
            rewardAmount = BigInt(eventArgs.rewardAmount);
            collateralReward = BigInt(eventArgs.collateralReward);

        } catch (error) {
            console.error("Error validating Claimed event:", error);
            return false;
        }

        expect(
            newDfireStaking.userStake.rewardSnapshot,
            "New rewardSnapshot must be equal to new totalRewardPerToken."
        ).to.equal(newDfireStaking.totalRewardPerToken);

        expect(
            newDfireStaking.userStake.collateralSnapshot,
            "New collateralSnapshot must be equal to new totalCollateralPerToken."
        ).to.equal(newDfireStaking.totalCollateralPerToken);

        expect(
            newDfireStaking.userStake.stake,
            "Stake amount must remain unchanged after claim."
        ).to.equal(prevDfireStaking.userStake.stake);

        expect(
            newDfireStaking.userPendingRewards.pendingRewardAmount,
            "User pending reward amount must be 0 after claim."
        ).to.equal(0n);
        expect(
            newDfireStaking.userPendingRewards.pendingCollateralReward,
            "User pending collateral reward must be 0 after claim."
        ).to.equal(0n);

        if (rewardAmount > 0n) {
            const expectedActorDFIDBalance = prevDFIDToken.accountBalances[actorAddress] + rewardAmount;
            expect(
                newDFIDToken.accountBalances[actorAddress],
                "Actor's DFIDToken balance must increase by rewardAmount."
            ).to.equal(expectedActorDFIDBalance);

            const expectedDFIREStakingDFIDBalance = prevDFIDToken.accountBalances[dfireStakingContractAddress] - rewardAmount;
            expect(
                newDFIDToken.accountBalances[dfireStakingContractAddress],
                "DFIREStaking DFIDToken balance must decrease by rewardAmount."
            ).to.equal(expectedDFIREStakingDFIDBalance);
        } else {
            expect(
                newDFIDToken.accountBalances[actorAddress],
                "Actor's DFIDToken balance should not change if rewardAmount is 0."
            ).to.equal(prevDFIDToken.accountBalances[actorAddress]);
            expect(
                newDFIDToken.accountBalances[dfireStakingContractAddress],
                "DFIREStaking DFIDToken balance should not change if rewardAmount is 0."
            ).to.equal(prevDFIDToken.accountBalances[dfireStakingContractAddress]);
        }

        if (collateralReward > 0n) {
            const expectedActorETHBalance = prevActorETHBalance + collateralReward - gasCost;
            expect(
                newActorETHBalance,
                "Actor's ETH balance must increase by collateralReward minus gasCost."
            ).to.equal(expectedActorETHBalance);

            const expectedDFIREStakingETHBalance = prevDFIREStakingETHBalance - collateralReward;
            expect(
                newDFIREStakingETHBalance,
                "DFIREStaking ETH balance must decrease by collateralReward."
            ).to.equal(expectedDFIREStakingETHBalance);
        } else {
            const expectedActorETHBalance = prevActorETHBalance - gasCost;
            expect(
                newActorETHBalance,
                "Actor's ETH balance should only decrease by gas cost if collateralReward is 0."
            ).to.equal(expectedActorETHBalance);
            expect(
                newDFIREStakingETHBalance,
                "DFIREStaking ETH balance should not change if collateralReward is 0."
            ).to.equal(prevDFIREStakingETHBalance);
        }

        return true;
    }
}
