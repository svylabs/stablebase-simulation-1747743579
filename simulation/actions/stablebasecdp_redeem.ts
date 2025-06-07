import { Action, Actor, RunContext, Snapshot } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

class RedeemAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('RedeemAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Parameter generation based on snapshot bounds
    const maxRedeemableAmount = currentSnapshot.accountSnapshot[actor.account.address] ?  Number(currentSnapshot.accountSnapshot[actor.account.address] / BigInt(100)) : 100 ;
    const amount = BigInt(Math.floor(context.prng.next() % maxRedeemableAmount) + 1); // Amount must be greater than 0

    const safesOrderedForLiquidationLength = Object.keys(currentSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes).length;
    const nearestSpotInLiquidationQueue = safesOrderedForLiquidationLength > 0 ? BigInt(Math.floor(context.prng.next() % safesOrderedForLiquidationLength)) : BigInt(0);

    // New identifier generation (redemptionId)
    const redemptionId = ethers.keccak256(
      ethers.utils.toUtf8Bytes(
        actor.account.address +
          amount.toString() +
          currentSnapshot.contractSnapshot.stableBaseCDP.totalDebt.toString() +
          context.prng.next().toString()
      )
    );

    const actionParams = [amount, nearestSpotInLiquidationQueue];
    const newIdentifiers = { redemptionId };

    return [actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const [amount, nearestSpotInLiquidationQueue] = actionParams;
    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .redeem(amount, nearestSpotInLiquidationQueue);

    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const [amount,] = actionParams;
    const contractAddress = this.contract.address;

    // Total Collateral should decrease
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral,
      'Total collateral should decrease'
    ).to.be.lte(previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral);

    // Total debt should decrease
    expect(
      newSnapshot.contractSnapshot.stableBaseCDP.totalDebt,
      'Total debt should decrease'
    ).to.be.lte(previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt);

    //SBD token should be burned. Get SBD contract from context.contracts
        const sbdTokenContract = context.contracts.dfidToken;
        const previousSBDContractBalance = previousSnapshot.accountSnapshot[sbdTokenContract.target] || BigInt(0);
        const newSBDContractBalance = newSnapshot.accountSnapshot[sbdTokenContract.target] || BigInt(0);
        expect(newSBDContractBalance - previousSBDContractBalance, 'SBD balance of contract should increase').to.be.eq(amount);

    //Check that the eth balance of the actor has increased
     expect(
      newSnapshot.accountSnapshot[actor.account.address],
      'ETH balance should increase'
    ).to.be.gt(previousSnapshot.accountSnapshot[actor.account.address]);

        // Check stability pool changes (if applicable based on conditions in the contract code)
        if (previousSnapshot.contractSnapshot.stableBaseCDP.stabilityPoolCanReceiveRewards) {
          // Assuming addReward or addCollateralReward are called on the stability pool
          const stabilityPoolAddress = (context.contracts.stabilityPool as any).target;

          const previousStabilityPoolBalance = previousSnapshot.accountSnapshot[stabilityPoolAddress] || BigInt(0);
          const newStabilityPoolBalance = newSnapshot.accountSnapshot[stabilityPoolAddress] || BigInt(0);
            //The StabilityPool balance can change based on the ownerFee/redeemerFee
        }

    return true;
  }
}

export default RedeemAction;
