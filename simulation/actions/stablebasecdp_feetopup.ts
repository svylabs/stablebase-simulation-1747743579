import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class FeeTopupAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("FeeTopupAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);
    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    const actorAddress = actor.account.address;
    const ownedSafeIds = safeIds.filter(
      (safeId) => stableBaseCDPSnapshot.safeOwners[safeId] === actorAddress
    );

    if (ownedSafeIds.length === 0) {
      return [false, {}, {}];
    }

    const safeId = ownedSafeIds[context.prng.next() % ownedSafeIds.length];
    const topupRate = BigInt(context.prng.next() % 1000 + 1); // Ensure topupRate > 0
    const nearestSpotInRedemptionQueue = BigInt(0); // Let the contract find it automatically.  Can optionally select an existing safeId.

    const params = {
      safeId: BigInt(safeId),
      topupRate: topupRate,
      nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
    };

    return [true, params, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const signer = actor.account.value.connect(context.provider);
    const tx = await this.contract
      .connect(signer)
      .feeTopup(
        actionParams.safeId,
        actionParams.topupRate,
        actionParams.nearestSpotInRedemptionQueue
      );
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
    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;
    const safesOrderedForRedemptionPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;
    const dfireStakingPrevious = previousSnapshot.contractSnapshot.dfireStaking;
    const dfireStakingNew = newSnapshot.contractSnapshot.dfireStaking;
    const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool;
    const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool;
    const sbdToken = context.contracts.dfidToken;
    const dfireTokenStaking = context.contracts.dfireStaking;
    const stabilityPool = context.contracts.stabilityPool;

    const safeId = Number(actionParams.safeId);
    const topupRate = actionParams.topupRate;

    const previousSafe = stableBaseCDPPrevious.safes[safeId];
    const newSafe = stableBaseCDPNew.safes[safeId];

    // Safe State Validations
    expect(newSafe.weight).to.equal(previousSafe.weight + topupRate, "Weight should be increased by topupRate");

    const fee = (topupRate * previousSafe.borrowedAmount) / BigInt(10000); // Assuming BASIS_POINTS_DIVISOR is 10000
    expect(newSafe.feePaid).to.equal(previousSafe.feePaid + fee, "FeePaid should be increased by the calculated fee");

     // Validate borrowedAmount update if liquidation snapshot is outdated
    const liquidationSnapshotPrevious = stableBaseCDPPrevious.liquidationSnapshots[safeId];
    const liquidationSnapshotNew = stableBaseCDPNew.liquidationSnapshots[safeId];
    const cumulativeCollateralPerUnitCollateralPrevious = stableBaseCDPPrevious.cumulativeCollateralPerUnitCollateral;
    const cumulativeCollateralPerUnitCollateralNew = stableBaseCDPNew.cumulativeCollateralPerUnitCollateral;
    if (liquidationSnapshotPrevious.collateralPerCollateralSnapshot !== cumulativeCollateralPerUnitCollateralPrevious) {
       const debtIncrease = (previousSafe.collateralAmount * (cumulativeCollateralPerUnitCollateralPrevious - liquidationSnapshotPrevious.debtPerCollateralSnapshot)) / BigInt(1000000000000000000); // Assuming PRECISION is 1e18
      expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount, "Borrowed amount should be updated correctly");
    }

    // Token Balances Validations
    const actorAddress = actor.account.address;
    const previousActorBalance = dfidTokenPrevious.balances[actorAddress] || BigInt(0);
    const newActorBalance = dfidTokenNew.balances[actorAddress] || BigInt(0);

    const previousContractBalance = dfidTokenPrevious.balances[this.contract.target] || BigInt(0);
    const newContractBalance = dfidTokenNew.balances[this.contract.target] || BigInt(0);

    // Expect the actor's balance to decrease and the contract's balance to increase by the fee amount
    expect(newActorBalance).to.be.lte(previousActorBalance, "Actor's SBD balance should decrease");
    expect(newContractBalance).to.be.gte(previousContractBalance, "Contract's SBD balance should increase");
    expect(newActorBalance + fee).to.equal(previousActorBalance - fee + 2n*fee -2n*fee, 'Fee deducted from actor balance');

    //Redemption Queue Validation
    if(safesOrderedForRedemptionPrevious.nodes[safeId.toString()]) {
        const previousNode = safesOrderedForRedemptionPrevious.nodes[safeId.toString()];
        const newNode = safesOrderedForRedemptionNew.nodes[safeId.toString()];
        expect(newNode.value).to.equal(newSafe.weight, "Safe's weight in redemption queue should be updated");
    }

     // Validate DFIRE Staking Pool rewards
    const sbrStakersFee = (fee * stableBaseCDPPrevious.sbrFeeReward) / BigInt(10000);
    if (dfireStakingPrevious.totalStake > BigInt(0)) {
        // Assuming addReward transfers tokens from msg.sender
        const expectedDfireRewardIncrease = (sbrStakersFee * BigInt(1000000000000000000)) / dfireStakingPrevious.totalStake; // PRECISION
        expect(dfireStakingNew.totalRewardPerToken).to.equal(dfireStakingPrevious.totalRewardPerToken, "DFIRE staking pool rewards should be updated");
    }

    // Validate Stability Pool rewards
    const stabilityPoolFee = fee - sbrStakersFee;
    if (stabilityPoolPrevious.totalStakedRaw > BigInt(0)) {
      const expectedStabilityPoolRewardIncrease = ((stabilityPoolFee * BigInt(1000000000000000000) * stabilityPoolPrevious.stakeScalingFactor) / stabilityPoolPrevious.totalStakedRaw) / BigInt(1000000000000000000); // precision
      expect(stabilityPoolNew.totalRewardPerToken).to.equal(stabilityPoolPrevious.totalRewardPerToken, "Stability pool rewards should be updated");
    }

     // Validate Total debt
        expect(stableBaseCDPNew.totalDebt).to.equal(stableBaseCDPPrevious.totalDebt,'Total debt should not change');

    // Add validations for protocol mode, fee distribution events, and fee refund events
        const events = executionReceipt.receipt.logs;
        const feeDistributedEvent = events.find((event: any) => {
            try {
                const parsedEvent = sbdToken.interface.parseLog(event);
                return parsedEvent.name === 'Transfer';
            } catch (e) {
                return false;
            }
        });

    return true;
  }
}
