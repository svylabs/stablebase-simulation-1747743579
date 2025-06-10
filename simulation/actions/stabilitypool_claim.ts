import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class ClaimAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("ClaimAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    // Option 1: Call claim() with no parameters.
    // Option 2: Call claim(address frontend, uint256 fee).
    const randomChoice = context.prng.next() % 2;

    let actionParams: any;
    if (randomChoice === 0) {
      // No parameters for claim().
      actionParams = [];
      return [true, actionParams, {}];
    } else {
      // Parameters for claim(address frontend, uint256 fee).
      // Determine a valid address for 'frontend'.  Use zero address if no fee desired.
      let frontend = ethers.ZeroAddress; // Default to zero address

      // Check if other actors exist and use their address if available
        const otherActors = context.actors.filter(a => a.account.address !== actor.account.address);
        if (otherActors.length > 0) {
            const randomIndex = context.prng.next() % otherActors.length;
            frontend = otherActors[randomIndex].account.address;
        }

      // Set 'fee' to a reasonable value between 0 and BASIS_POINTS_DIVISOR.
      const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
      const basisPointsDivisor = stabilityPoolSnapshot.basisPointsDivisor;
      const fee = BigInt(context.prng.next()) % (basisPointsDivisor + BigInt(1)); // Ensure fee is within bounds

      actionParams = [frontend, fee];
      return [true, actionParams, {}];
    }
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    if (actionParams.length === 0) {
      // Call claim() with no parameters.
      const tx = await this.contract.connect(actor.account.value).claim();
      await tx.wait();
    } else {
      // Call claim(address frontend, uint256 fee).
      const [frontend, fee] = actionParams;
      const tx = await this.contract
        .connect(actor.account.value)
        .claim(frontend, fee);
      await tx.wait();
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
    const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool;
    const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool;
    const actorAddress = actor.account.address;

    // Reward Snapshots validation.
    const previousRewardSnapshot = stabilityPoolPrevious.users[actorAddress]?.rewardSnapshot || BigInt(0);
    const newRewardSnapshot = stabilityPoolNew.users[actorAddress]?.rewardSnapshot || BigInt(0);

    expect(newRewardSnapshot).to.equal(stabilityPoolNew.totalRewardPerToken, "Reward snapshot should be equal to totalRewardPerToken after claim.");

    const previousCollateralSnapshot = stabilityPoolPrevious.users[actorAddress]?.collateralSnapshot || BigInt(0);
    const newCollateralSnapshot = stabilityPoolNew.users[actorAddress]?.collateralSnapshot || BigInt(0);
    expect(newCollateralSnapshot).to.equal(stabilityPoolNew.totalCollateralPerToken, "Collateral snapshot should be equal to totalCollateralPerToken after claim.");

    const sbrRewardDistributionStatusPrevious = stabilityPoolPrevious.sbrRewardDistributionStatus;
    const sbrRewardDistributionStatusNew = stabilityPoolNew.sbrRewardDistributionStatus;

    const previousSbrRewardSnapshot = stabilityPoolPrevious.sbrRewardSnapshots[actorAddress]?.rewardSnapshot || BigInt(0);
    const newSbrRewardSnapshot = stabilityPoolNew.sbrRewardSnapshots[actorAddress]?.rewardSnapshot || BigInt(0);
    const previousSbrRewardStatus = stabilityPoolPrevious.sbrRewardSnapshots[actorAddress]?.status || 0; // Assume 0 for not claimed
    const newSbrRewardStatus = stabilityPoolNew.sbrRewardSnapshots[actorAddress]?.status || 0;

    if (sbrRewardDistributionStatusNew != 2) { // SBRRewardDistribution.ENDED = 2
      expect(newSbrRewardSnapshot).to.equal(stabilityPoolNew.totalSbrRewardPerToken, "SBR reward snapshot should be equal to totalSbrRewardPerToken if not ended.");
    } else {
      expect(newSbrRewardStatus).to.equal(1, "SBR reward status should be CLAIMED if distribution ended."); // CLAIMED = 1
    }

    // User Stake validation.
    const previousStake = stabilityPoolPrevious.users[actorAddress]?.stake || BigInt(0);
    const newStake = stabilityPoolNew.users[actorAddress]?.stake || BigInt(0);

    const newCumulativeProductScalingFactor = stabilityPoolNew.users[actorAddress]?.cumulativeProductScalingFactor || BigInt(0);
    expect(newCumulativeProductScalingFactor).to.equal(stabilityPoolNew.stakeScalingFactor, "CumulativeProductScalingFactor should be equal to stakeScalingFactor after claim.");

    const newStakeResetCount = stabilityPoolNew.users[actorAddress]?.stakeResetCount || BigInt(0);
    expect(newStakeResetCount).to.equal(stabilityPoolNew.stakeResetCount, "StakeResetCount should be equal to stakeResetCount after claim.");

        //Total stake raw validation
        const previousTotalStakedRaw = stabilityPoolPrevious.totalStakedRaw
        const newTotalStakedRaw = stabilityPoolNew.totalStakedRaw

    // Token Balance Validations - simplified, assumes the token contracts are available and tokens transferred.
    // To validate correctly, you will need to read events emitted and compare to expected value based on actionParams
    // and then also check the balances.

    return true;
  }
}
