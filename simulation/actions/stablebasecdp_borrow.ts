import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class BorrowAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("BorrowAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const safeId = actor.identifiers.safeId;
    if (!safeId) {
      console.log("SafeId not available, cannot proceed with Borrow action");
      return [false, {}, {}];
    }

    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const accountSnapshot = currentSnapshot.accountSnapshot[actor.account.address];

    const safeInfo = currentSnapshot.contractSnapshot.stableBaseCDP.safes[safeId.toString()];

    if (!safeInfo) {
      console.log("Safe does not exist, cannot proceed with Borrow action");
      return [false, {}, {}];
    }
    if (safeInfo.collateralAmount === BigInt(0)) {
        console.log("Safe has no collateral, cannot proceed with Borrow action");
        return [false, {}, {}];
    }

    const priceOracle = context.contracts.mockPriceOracle;
    const price = await priceOracle.fetchPrice();

    const liquidationRatio = BigInt(20000); // Example liquidation ratio
    const basisPointsDivisor = BigInt(10000);
    const minimumDebt = stableBaseCDPSnapshot.minimumDebt

    const maxBorrowAmount = ((
        (safeInfo.collateralAmount * price * basisPointsDivisor)
    ) / liquidationRatio) / BigInt(100000000);

    const availableEth = accountSnapshot || BigInt(0)

    if (maxBorrowAmount <= safeInfo.borrowedAmount) {
        console.log("Max borrow amount is less than or equal to the current borrowed amount");
        return [false, {}, {}];
    }

    let amount = BigInt(Math.floor(context.prng.next() % Number(maxBorrowAmount - safeInfo.borrowedAmount))) + BigInt(1);

    if (safeInfo.borrowedAmount + amount > maxBorrowAmount || safeInfo.borrowedAmount + amount < minimumDebt) {
      console.log("Borrow amount exceeds the limit or is invalid, cannot proceed with Borrow action");
      return [false, {}, {}];
    }

    const shieldingRate = BigInt(Math.floor(context.prng.next() % 10000)); // between 0 and BASIS_POINTS_DIVISOR
    const nearestSpotInLiquidationQueue = BigInt(0); // Or a valid safeId
    const nearestSpotInRedemptionQueue = BigInt(0); // Or a valid safeId

    const params = {
      safeId: safeId,
      amount: amount,
      shieldingRate: shieldingRate,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
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
    const { safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .borrow(
        safeId,
        amount,
        shieldingRate,
        nearestSpotInLiquidationQueue,
        nearestSpotInRedemptionQueue
      );

    return { tx: tx, emittedEvents: [] };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { safeId, amount, shieldingRate } = actionParams;

    const previousSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId.toString()];
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId.toString()];

    const previousTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const bootstrapModeDebtThreshold = previousSnapshot.contractSnapshot.stableBaseCDP.bootstrapModeDebtThreshold;

    const previousProtocolMode = previousSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
    const newProtocolMode = newSnapshot.contractSnapshot.stableBaseCDP.protocolMode;

    const dfidTokenAddress = (context.contracts.dfidToken as any).target;
    const previousSBDTokenBalance = previousSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);
    const newSBDTokenBalance = newSnapshot.contractSnapshot.dfidToken.balances[actor.account.address] || BigInt(0);
    const previousContractSBDTokenBalance = previousSnapshot.contractSnapshot.dfidToken.balances[dfidTokenAddress] || BigInt(0);
    const newContractSBDTokenBalance = newSnapshot.contractSnapshot.dfidToken.balances[dfidTokenAddress] || BigInt(0);

    const basisPointsDivisor = BigInt(10000);

    // Calculate shielding fee based on weight. This part depends on contract internal logic.
    let _shieldingFee = BigInt(0);
    if (shieldingRate > BigInt(0)) {
        _shieldingFee = (amount * shieldingRate) / basisPointsDivisor;
    }

    const _amountToBorrow = amount - _shieldingFee;

    // Validate Safe state
    expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amount, "Borrowed amount mismatch");
    expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amount, "Total borrowed amount mismatch");
    expect(newSafe.feePaid).to.gte(previousSafe.feePaid, "Fee paid mismatch");

    // Validate Total Debt
    expect(newTotalDebt).to.equal(previousTotalDebt + amount, "Total debt mismatch");

    // Validate SBD Token balance
    expect(newSBDTokenBalance).to.equal(previousSBDTokenBalance + _amountToBorrow, "SBD token balance mismatch");

    // Validate contract's SBD token balance
    expect(newContractSBDTokenBalance).to.gte(previousContractSBDTokenBalance, "Contract SBD token balance mismatch");

    const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const expectedAccountBalance = previousAccountBalance // The action does not directly affect account ETH balance

    expect(newAccountBalance).to.equal(expectedAccountBalance, 'Account balance should remain the same');


    //Protocol Mode Validation
    if (previousProtocolMode === 0 && newProtocolMode === 1) { // Assuming 0 is BOOTSTRAP and 1 is NORMAL
      expect(newTotalDebt).to.be.above(bootstrapModeDebtThreshold, "Total debt should exceed bootstrap threshold");
    }
    else {
        expect(newProtocolMode).to.equal(previousProtocolMode, "Protocol mode should not change");
    }

    return true;
  }
}
