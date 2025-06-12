import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class LiquidateAction extends Action {
  contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("LiquidateAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPContract = context.contracts.stableBaseCDP;
    const safesOrderedForLiquidationContract = context.contracts.safesOrderedForLiquidation;
    const mockPriceOracle = context.contracts.mockPriceOracle;
    const safesOrderedForLiquidation = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
    const dfireStakingSnapshot = currentSnapshot.contractSnapshot.dfireStaking;

    const tailId = safesOrderedForLiquidation.tailId;

    if (tailId === BigInt(0)) {
      return [false, {}, {}];
    }

    let safeId = tailId;
    let safe = stableBaseCDPSnapshot.safesData[Number(safeId)];
    let collateralPrice = currentSnapshot.contractSnapshot.mockPriceOracle.currentPrice;

    // Iterate through the safesOrderedForLiquidation to find a suitable safe
    let currentSafeId = tailId;
    while (currentSafeId !== BigInt(0)) {
      safe = stableBaseCDPSnapshot.safesData[Number(currentSafeId)];
      collateralPrice = currentSnapshot.contractSnapshot.mockPriceOracle.currentPrice;

      if (safe && safe.collateralAmount !== BigInt(0) && safe.borrowedAmount !== BigInt(0)) {
        const collateralValue = (safe.collateralAmount * collateralPrice) / BigInt(10 ** 18);

        const liquidationRatio = BigInt(15000); // Example liquidation ratio, adjust as needed
        const BASIS_POINTS_DIVISOR = BigInt(10000);
        if (collateralValue < ((safe.borrowedAmount * liquidationRatio) / BASIS_POINTS_DIVISOR)) {
          safeId = currentSafeId;
          break;
        }
      }
      currentSafeId = safesOrderedForLiquidation.nodes[Number(currentSafeId)]?.prev || BigInt(0);
    }

    // If no suitable safe is found, return false
    if (currentSafeId === BigInt(0)) {
        return [false, {}, {}];
    }

    try {
      return [true, { safeId: safeId }, {}];
    } catch (e) {
      console.log(e);
      return [false, {}, {}];
    }
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract.connect(actor.account.value).liquidate();
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

    const safesOrderedForLiquidationPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
    const safesOrderedForLiquidationNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    const safesOrderedForRedemptionPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
    const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;

    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const safeId = actionParams.safeId;

    const safePrevious = stableBaseCDPPrevious.safesData[Number(safeId)];

    if(safePrevious !== undefined){
        expect(stableBaseCDPNew.safesData[Number(safeId)]).to.be.undefined;
    }

    const collateralLossDiff = stableBaseCDPNew.collateralLoss - stableBaseCDPPrevious.collateralLoss;
    const debtLossDiff = stableBaseCDPNew.debtLoss - stableBaseCDPPrevious.debtLoss;
    const totalCollateralDiff = stableBaseCDPPrevious.totalCollateral - stableBaseCDPNew.totalCollateral;
    const totalDebtDiff = stableBaseCDPPrevious.totalDebt - stableBaseCDPNew.totalDebt;

    const headIdPrevious = safesOrderedForLiquidationPrevious.headId;
    const tailIdPrevious = safesOrderedForLiquidationPrevious.tailId;
    const tailIdNew = safesOrderedForLiquidationNew.tailId;

    const tailIdPreviousValue = safesOrderedForLiquidationPrevious.nodes[Number(tailIdPrevious)]?.value;

    if (tailIdPrevious === safeId) {
        if (safesOrderedForLiquidationNew.headId === BigInt(0)) {
            expect(safesOrderedForLiquidationNew.tailId).to.equal(BigInt(0));
        } else {
            expect(safesOrderedForLiquidationNew.tailId).to.not.equal(tailIdPrevious);
        }
    }

    expect(stableBaseCDPNew.totalCollateral).to.be.lte(stableBaseCDPPrevious.totalCollateral);
    expect(stableBaseCDPNew.totalDebt).to.be.lte(stableBaseCDPPrevious.totalDebt);

         // Validate cumulativeCollateralPerUnitCollateral
    const cumulativeCollateralPerUnitCollateralPrevious = stableBaseCDPPrevious.cumulativeCollateralPerUnitCollateral;
    const cumulativeCollateralPerUnitCollateralNew = stableBaseCDPNew.cumulativeCollateralPerUnitCollateral;
    expect(cumulativeCollateralPerUnitCollateralNew).to.be.gte(cumulativeCollateralPerUnitCollateralPrevious, 'cumulativeCollateralPerUnitCollateral should increase or remain the same');

    // Validate cumulativeDebtPerUnitCollateral
    const cumulativeDebtPerUnitCollateralPrevious = stableBaseCDPPrevious.cumulativeDebtPerUnitCollateral;
    const cumulativeDebtPerUnitCollateralNew = stableBaseCDPNew.cumulativeDebtPerUnitCollateral;
    expect(cumulativeDebtPerUnitCollateralNew).to.be.gte(cumulativeDebtPerUnitCollateralPrevious, 'cumulativeDebtPerUnitCollateral should increase or remain the same');


    // Validate protocol mode
    const protocolModePrevious = stableBaseCDPPrevious.protocolMode;
    const protocolModeNew = stableBaseCDPNew.protocolMode;
    if (stableBaseCDPPrevious.totalDebt <= BigInt(5000000 * 10 ** 18) && stableBaseCDPNew.totalDebt > BigInt(5000000 * 10 ** 18)) {
        expect(protocolModeNew).to.equal(1, 'PROTOCOL_MODE should transition to NORMAL'); // Assuming NORMAL is 1
    } else {
        expect(protocolModeNew).to.equal(protocolModePrevious, 'PROTOCOL_MODE should remain the same');
    }

    //validate sbdToken balance changes
    const dfidTokenBalancePrevious = dfidTokenPrevious.balances[context.contracts.stabilityPool.target];
    const dfidTokenBalanceNew = dfidTokenNew.balances[context.contracts.stabilityPool.target];

    if(dfidTokenBalancePrevious !== undefined && dfidTokenBalanceNew !== undefined){
         expect(dfidTokenBalanceNew).to.be.lte(dfidTokenBalancePrevious);
    }

    //validate DfireStaking balance changes

    return true;
  }
}
