import { ethers } from "ethers";
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";
import { expect } from 'chai';
import {
    DFIDTokenSnapshot,
    DFIRETokenSnapshot,
    DFIREStakingSnapshot,
    StabilityPoolSnapshot,
    StableBaseCDPSnapshot,
    OrderedDoublyLinkedListSnapshot,
    MockPriceOracleSnapshot
} from "@svylabs/ilumia";

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
    ): Promise<[any, Record<string, any>]> {
        // The `liquidate` function does not take direct input parameters.
        // Return an empty array for action parameters and an empty object for new identifiers.
        return [[], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        // Execute the `liquidate` function.
        const tx = await this.contract.connect(actor.account.value).liquidate();
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const stableBaseCDPPrevious: StableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const stableBaseCDPNew: StableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        const safesOrderedForLiquidationPrevious: OrderedDoublyLinkedListSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const safesOrderedForLiquidationNew: OrderedDoublyLinkedListSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

        const safesOrderedForRedemptionPrevious: OrderedDoublyLinkedListSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const safesOrderedForRedemptionNew: OrderedDoublyLinkedListSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        const dfidTokenPrevious: DFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const dfidTokenNew: DFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const stabilityPoolPrevious: StabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
        const stabilityPoolNew: StabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

        const dfireStakingPrevious: DFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking;
        const dfireStakingNew: DFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;


        // Get SafeID before liquidation from the queue
        const safeId = safesOrderedForLiquidationPrevious.tail;

        // If no safe to liquidate, return true
        if (safeId === 0n) return true;

        const safePrevious = stableBaseCDPPrevious.safes[safeId];
        const safeNew = stableBaseCDPNew.safes[safeId];

        // Safe Removal
        expect(safeNew, `Safe with id ${safeId} should be removed`).to.be.undefined;

        // Total Debt and Collateral
        const borrowedAmount = safePrevious ? safePrevious.borrowedAmount : 0n;
        const collateralAmount = safePrevious ? safePrevious.collateralAmount : 0n;

        expect(stableBaseCDPNew.totalDebt, 'Total debt should decrease').to.equal(stableBaseCDPPrevious.totalDebt - borrowedAmount);
        expect(stableBaseCDPNew.totalCollateral, 'Total collateral should decrease').to.equal(stableBaseCDPPrevious.totalCollateral - collateralAmount);

        // Queue Management
        expect(safesOrderedForLiquidationNew.tail !== safeId, 'Safe should be removed from liquidation queue').to.be.true;
        expect(safesOrderedForRedemptionNew.tail !== safeId, 'Safe should be removed from redemption queue').to.be.true;

        // Stability Pool Update (if applicable)
        const stabilityPoolBorrowedAmount = (stabilityPoolPrevious && safePrevious && stabilityPoolPrevious.totalStakedRaw >= borrowedAmount) ? borrowedAmount : 0n;
        const burnedAmount = stabilityPoolBorrowedAmount;

        if (stabilityPoolBorrowedAmount > 0n) {
          expect(stabilityPoolNew.totalStakedRaw, 'Total staked raw in stability pool should decrease').to.equal(stabilityPoolPrevious.totalStakedRaw - stabilityPoolBorrowedAmount);
          expect(dfidTokenNew.totalTokenSupply, 'SBD total supply should decrease').to.equal(dfidTokenPrevious.totalTokenSupply - burnedAmount);
        }

        //Debt and Collateral Distribution (Secondary Liquidation)
        if (borrowedAmount > stabilityPoolPrevious.totalStakedRaw) {
          expect(stableBaseCDPNew.collateralLoss, 'collateralLoss should be updated').to.be.at.most(stableBaseCDPPrevious.collateralLoss);
          expect(stableBaseCDPNew.debtLoss, 'debtLoss should be updated').to.be.at.most(stableBaseCDPPrevious.debtLoss);
          expect(stableBaseCDPNew.cumulativeCollateralPerUnitCollateral, 'cumulativeCollateralPerUnitCollateral should be incremented').to.be.greaterThan(stableBaseCDPPrevious.cumulativeCollateralPerUnitCollateral);
          expect(stableBaseCDPNew.cumulativeDebtPerUnitCollateral, 'cumulativeDebtPerUnitCollateral should be incremented').to.be.greaterThan(stableBaseCDPPrevious.cumulativeDebtPerUnitCollateral);
        }

          // DFIRE Staking Pool Update (if applicable)
          if (dfireStakingPrevious.totalCollateralPerToken !== dfireStakingNew.totalCollateralPerToken) {
              expect(dfireStakingNew.totalCollateralPerToken, 'DFIRE staking pool collateral per token should increase').to.be.greaterThan(dfireStakingPrevious.totalCollateralPerToken);
          }

        return true;
    }
}