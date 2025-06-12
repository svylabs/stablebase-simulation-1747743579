import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class LiquidateSafeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("LiquidateSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const stabilityPoolSnapshot = currentSnapshot.contractSnapshot.stabilityPool;
    const safeIds = Object.keys(stableBaseCDPSnapshot.safesData).map(Number);

    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    let safeIdToLiquidate: number | undefined;

    try {
      for (const safeId of safeIds) {
        const safe = stableBaseCDPSnapshot.safesData[safeId];
        if (safe && safe.collateralAmount > BigInt(0) && safe.borrowedAmount > BigInt(0)) {
          // Fetch collateralPrice from MockPriceOracle
          const collateralPrice = currentSnapshot.contractSnapshot.mockPriceOracle.currentPrice;
          const PRECISION = BigInt(10 ** 18);
          const BASIS_POINTS_DIVISOR = BigInt(10000);
          const liquidationRatio = BigInt(11000); // Assuming a liquidation ratio of 110%
          const collateralValue = (safe.collateralAmount * collateralPrice) / PRECISION;
          const liquidationThreshold = (safe.borrowedAmount * liquidationRatio) / BASIS_POINTS_DIVISOR;

          if (collateralValue < liquidationThreshold) {
            // Additional checks: StabilityPool and liquidation queue
            const borrowedAmount = safe.borrowedAmount;
            const isLiquidationPossible = stabilityPoolSnapshot.isLiquidationPossible && borrowedAmount <= stabilityPoolSnapshot.totalStakedRaw;

            //check if safeId is the last Safe in the liquidation queue, the transaction should revert with message Cannot liquidate the last Safe
            const safesOrderedForLiquidation = currentSnapshot.contractSnapshot.safesOrderedForLiquidation
            const lastSafeId = safesOrderedForLiquidation.headId;
            if (!isLiquidationPossible && BigInt(safeId) == lastSafeId) {
              continue; // Skip this safe
            }

            safeIdToLiquidate = safeId;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Error during initialization checks:", error);
      return [false, {}, {}]; // Or handle the error as appropriate
    }

    if (safeIdToLiquidate === undefined) {
      return [false, {}, {}];
    }

    const actionParams = {
      safeId: BigInt(safeIdToLiquidate),
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const signer = actor.account.value.connect(this.contract.provider);
    const tx = await this.contract
      .connect(signer)
      .liquidateSafe(actionParams.safeId);

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
    const safeId = actionParams.safeId;
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
    const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

    // Safe should no longer exist
    expect(newStableBaseCDPSnapshot.safesData[Number(safeId)]).to.be.undefined;

    // Verify totalCollateral and totalDebt decreased
    const previousCollateral = previousStableBaseCDPSnapshot.safesData[Number(safeId)].collateralAmount;
    const previousDebt = previousStableBaseCDPSnapshot.safesData[Number(safeId)].borrowedAmount;

    expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(previousStableBaseCDPSnapshot.totalCollateral - previousCollateral, "Total collateral should decrease");
    expect(newStableBaseCDPSnapshot.totalDebt).to.equal(previousStableBaseCDPSnapshot.totalDebt - previousDebt, "Total debt should decrease");

    // Check NFT is burned - ownerOf(safeId) should return address(0)
    const nullAddress = ethers.ZeroAddress;
    const stableBaseCDPContract = context.contracts.stableBaseCDP;
    const owner = await stableBaseCDPContract.ownerOf(safeId);
    expect(owner).to.equal(nullAddress, "NFT should be burned");

    // Check balances (ETH)
    const previousEthBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
    const newEthBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

    expect(newEthBalance).to.be.gte(previousEthBalance, "ETH balance should increase due to gas compensation");

    // Verify StabilityPool state variables
    expect(newStabilityPoolSnapshot.totalStakedRaw).to.be.lte(previousStabilityPoolSnapshot.totalStakedRaw, "totalStakedRaw should decrease or remain the same");
    expect(newStabilityPoolSnapshot.stakeScalingFactor).to.be.lte(previousStabilityPoolSnapshot.stakeScalingFactor, "stakeScalingFactor should decrease or remain the same");

    //Verify total burned and total supply of DFIDToken
    const borrowedAmount = previousStableBaseCDPSnapshot.safesData[Number(safeId)].borrowedAmount
    expect(newDFIDTokenSnapshot.totalBurned).to.equal(previousDFIDTokenSnapshot.totalBurned + borrowedAmount, "DFIDToken totalBurned should increase");
    expect(newDFIDTokenSnapshot.totalSupply).to.equal(previousDFIDTokenSnapshot.totalSupply - borrowedAmount, "DFIDToken totalSupply should decrease");

    // Price oracle should not change
    expect(newSnapshot.contractSnapshot.mockPriceOracle.currentPrice).to.equal(previousSnapshot.contractSnapshot.mockPriceOracle.currentPrice, 'Price should not change');

    // Check for events emitted
    // This part requires access to the executionReceipt and parsing of events.  This is a placeholder.
    // You would need to iterate through the logs in executionReceipt.receipt.logs and check for the specific events.

    return true;
  }
}
