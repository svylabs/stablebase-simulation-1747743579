import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';

class ClaimAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("ClaimAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[[address: string, bigint] | [], Record<string, any>]> {
        // Determine whether to use the overloaded function or not.
        const useOverloaded = context.prng.next() % 2 === 0;
        let params: [address: string, bigint] | [] = [];
        if (useOverloaded) {
            // Generate parameters for the overloaded function
            const frontend = ethers.Wallet.createRandom().address; // Generate a random Ethereum address
            const fee = BigInt(context.prng.next() % 10001); // Generate a random fee between 0 and 10000 (0% to 100%)
            params = [frontend, fee];
        }

        return [params, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: [address: string, bigint] | []
    ): Promise<Record<string, any> | void> {
        if (actionParams.length === 0) {
            // Call the function without parameters
            const tx = await this.contract.connect(actor.account.value).claim();
            await tx.wait();
        } else {
            // Call the function with frontend and fee parameters
            const [frontend, fee] = actionParams;
            const tx = await this.contract.connect(actor.account.value).claim(frontend, fee);
            await tx.wait();
        }
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: [address: string, bigint] | []
    ): Promise<boolean> {
        const stabilityPoolPreviousState = previousSnapshot.contractSnapshot.stabilityPool.state;
        const stabilityPoolNewState = newSnapshot.contractSnapshot.stabilityPool.state;
        const accountAddress = actor.account.address;

        const userPreviousInfo = stabilityPoolPreviousState.users[accountAddress] || { stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0), cumulativeProductScalingFactor: BigInt(0), stakeResetCount: BigInt(0) };
        const userNewInfo = stabilityPoolNewState.users[accountAddress] || { stake: BigInt(0), rewardSnapshot: BigInt(0), collateralSnapshot: BigInt(0), cumulativeProductScalingFactor: BigInt(0), stakeResetCount: BigInt(0) };

        const sbrRewardSnapshotsPrevious = stabilityPoolPreviousState.sbrRewardSnapshots[accountAddress] || { rewardSnapshot: BigInt(0), status: 0 };
        const sbrRewardSnapshotsNew = stabilityPoolNewState.sbrRewardSnapshots[accountAddress] || { rewardSnapshot: BigInt(0), status: 0 };

        // Reward and Collateral Snapshot Updates
        expect(userNewInfo.rewardSnapshot).to.equal(stabilityPoolNewState.totalRewardPerToken, "User's rewardSnapshot should be equal to the totalRewardPerToken after the claim.");
        expect(userNewInfo.collateralSnapshot).to.equal(stabilityPoolNewState.totalCollateralPerToken, "User's collateralSnapshot should be equal to the totalCollateralPerToken after the claim.");

        // SBR Reward Snapshot Updates
        if (stabilityPoolPreviousState.sbrRewardDistributionStatus !== 2) { // SBRRewardDistribution.ENDED = 2
            expect(sbrRewardSnapshotsNew.rewardSnapshot).to.equal(stabilityPoolNewState.totalSbrRewardPerToken, "If sbrRewardDistributionStatus is not ENDED before the claim, sbrRewardSnapshots[msg.sender].rewardSnapshot should be updated to totalSbrRewardPerToken after claim.");
        } else if (sbrRewardSnapshotsPrevious.status !== 2) { // SBRRewardDistribution.CLAIMED = 2
            expect(sbrRewardSnapshotsNew.status).to.equal(2, "If sbrRewardDistributionStatus is ENDED before the claim and sbrRewardSnapshots[msg.sender].status is not CLAIMED, sbrRewardSnapshots[msg.sender].status should be updated to CLAIMED after claim.");
        }

        // User Stake Updates
        // Since the stake update depends on internal calculations, a precise comparison is difficult without reimplementing the logic.
        // Instead, we can check if the stake, cumulativeProductScalingFactor, and stakeResetCount have been updated.
        if (userPreviousInfo.cumulativeProductScalingFactor != BigInt(0)) {
            expect(userNewInfo.stake).to.not.equal(userPreviousInfo.stake, "The user's stake should be updated according to _getUserEffectiveStake after claim.");
        }
        expect(userNewInfo.cumulativeProductScalingFactor).to.equal(stabilityPoolNewState.stakeScalingFactor, "The user's cumulativeProductScalingFactor should be updated to stakeScalingFactor after claim.");
        expect(userNewInfo.stakeResetCount).to.equal(stabilityPoolNewState.stakeResetCount, "The user's stakeResetCount should be updated to stakeResetCount after claim.");

        // Token Balances
        const dfidTokenAddress = context.contracts.dfidToken.target;
        const dfireTokenAddress = context.contracts.dfireToken.target;

        const previousStakingTokenBalance = previousSnapshot.contractSnapshot.dfidToken?.accountBalance || BigInt(0);
        const newStakingTokenBalance = newSnapshot.contractSnapshot.dfidToken?.accountBalance || BigInt(0);

        const previousEthBalance = previousSnapshot.accountSnapshot[accountAddress] || BigInt(0);
        const newEthBalance = newSnapshot.accountSnapshot[accountAddress] || BigInt(0);

        const previousSbrTokenBalance = previousSnapshot.contractSnapshot.dfireToken.balances?.[accountAddress] || BigInt(0);
        const newSbrTokenBalance = newSnapshot.contractSnapshot.dfireToken.balances?.[accountAddress] || BigInt(0);

        let rewardFee = BigInt(0);
        let collateralFee = BigInt(0);
        let sbrFee = BigInt(0);

        if (actionParams.length > 0) {
            const [, fee] = actionParams;
            const pendingReward = (((stabilityPoolPreviousState.totalRewardPerToken - userPreviousInfo.rewardSnapshot) * userPreviousInfo.stake) * stabilityPoolPreviousState.precision) / userPreviousInfo.cumulativeProductScalingFactor / stabilityPoolPreviousState.precision;
            const pendingCollateral = (((stabilityPoolPreviousState.totalCollateralPerToken - userPreviousInfo.collateralSnapshot) * userPreviousInfo.stake) * stabilityPoolPreviousState.precision) / userPreviousInfo.cumulativeProductScalingFactor / stabilityPoolPreviousState.precision;
            const pendingSbrRewards = (((stabilityPoolPreviousState.totalSbrRewardPerToken - sbrRewardSnapshotsPrevious.rewardSnapshot) * userPreviousInfo.stake) * stabilityPoolPreviousState.precision) / userPreviousInfo.cumulativeProductScalingFactor / stabilityPoolPreviousState.precision;


            rewardFee = (fee * pendingReward) / 10000; // Assuming BASIS_POINTS_DIVISOR is 10000
            collateralFee = (fee * pendingCollateral) / 10000;
            sbrFee = (fee * pendingSbrRewards) / 10000;
        }


        // Verify changes in token balances due to reward claims
        if (userPreviousInfo.stake > BigInt(0)) { // only validate token transfers if the user has some stake
            //stakingToken balance
            expect(newStakingTokenBalance).to.equal(previousStakingTokenBalance, 'newStakingTokenBalance should increase by pendingReward - rewardFee');
            //ETH balance
            expect(newEthBalance).to.equal(previousEthBalance, 'newEthBalance should increase by pendingCollateral - collateralFee');
            //sbrToken balance
            expect(newSbrTokenBalance).to.equal(previousSbrTokenBalance, 'newSbrTokenBalance should increase by pendingSbrRewards - sbrFee');
        }

        // SBR Reward Distribution Status
        if (stabilityPoolPreviousState.sbrRewardDistributionStatus === 0) { // SBRRewardDistribution.NOT_STARTED = 0
            expect(stabilityPoolNewState.sbrRewardDistributionStatus).to.equal(1, "If SBR reward distribution is NOT_STARTED before the claim, sbrRewardDistributionStatus should transition to STARTED after the claim."); // SBRRewardDistribution.STARTED = 1
        } else if (stabilityPoolPreviousState.sbrRewardDistributionStatus === 1) { // SBRRewardDistribution.STARTED = 1
            expect(stabilityPoolNewState.lastSBRRewardDistributedTime).to.equal(BigInt((newSnapshot.block as any).timestamp), "If SBR reward distribution is STARTED before the claim, lastSBRRewardDistributedTime should be updated to block.timestamp after the claim.");
        }

        // TODO: Add validation for event emissions.  This requires access to events from the snapshots.

        return true;
    }
}

export default ClaimAction;
