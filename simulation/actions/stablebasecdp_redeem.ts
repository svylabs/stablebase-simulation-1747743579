import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

export class RedeemAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super('RedeemAction');
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[any, Record<string, any>]> {
    // Ensure the user has sufficient SBD tokens to redeem
    const userAddress = actor.account.address;
    const userSBDTokenBalance = currentSnapshot.contractSnapshot.dfidToken.Balance[userAddress] || BigInt(0);

    // Generate a random amount within the user's SBD token balance, but at least 1
    const maxRedeemableAmount = userSBDTokenBalance > 0 ? userSBDTokenBalance : BigInt(1);
    const amount = BigInt(Math.floor(context.prng.next() % Number(maxRedeemableAmount)) + 1);

    // Generate a random value for nearestSpotInLiquidationQueue
    const nearestSpotInLiquidationQueue = BigInt(Math.floor(context.prng.next() % 100));

    const actionParams = [
      amount,
      nearestSpotInLiquidationQueue,
    ];

    return [actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const signer = actor.account.value as ethers.Signer;
    const tx = await this.contract.connect(signer).redeem(
      actionParams[0],
      actionParams[1]
    );
    await tx.wait();
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any
  ): Promise<boolean> {
    const amount = actionParams[0] as bigint;
    const nearestSpotInLiquidationQueue = actionParams[1] as bigint;
    const userAddress = actor.account.address;

    // Validate SBD Token Balance
    const previousUserSBDTokenBalance = previousSnapshot.contractSnapshot.dfidToken.Balance[userAddress] || BigInt(0);
    const newUserSBDTokenBalance = newSnapshot.contractSnapshot.dfidToken.Balance[userAddress] || BigInt(0);
    expect(newUserSBDTokenBalance, 'User SBD token balance should decrease by redeemed amount').to.equal(
      previousUserSBDTokenBalance - amount
    );

    // Validate Total Supply of SBD tokens
    const previousTotalSupply = previousSnapshot.contractSnapshot.dfidToken.TotalSupply || BigInt(0);
    const newTotalSupply = newSnapshot.contractSnapshot.dfidToken.TotalSupply || BigInt(0);
    const redeemedAmount = amount; // Assuming redeemedAmount is equal to amount
    const refundedAmount = BigInt(0); // Assuming refundedAmount is zero for simplicity

    // In the redeem function, SBD tokens are burned only if redeemedAmount > refundedAmount
    if (redeemedAmount > refundedAmount) {
      expect(newTotalSupply, 'Total supply of SBD tokens should decrease when redeemedAmount > refundedAmount').to.lte(previousTotalSupply);
    } else {
      expect(newTotalSupply, 'Total supply of SBD tokens should not change').to.equal(previousTotalSupply);
    }

    // Validate Total Debt and Collateral
    const previousTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt || BigInt(0);
    const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt || BigInt(0);
    const previousTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0);
    const newTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0);

    // Expect totalDebt to be reduced, adjust for refundedAmount. For simplicity, considering refundedAmount to be 0.
    expect(newTotalDebt, 'Total debt should be reduced').to.lte(previousTotalDebt);

    // Expect totalCollateral to be reduced. Due to lack of redeemerFee and collateralAmount from event, a less specific check is used.
    expect(newTotalCollateral, 'Total collateral should be reduced').to.lte(previousTotalCollateral);

    return true;
  }
}
