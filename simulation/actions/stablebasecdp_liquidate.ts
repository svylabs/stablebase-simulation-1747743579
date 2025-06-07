import { ethers } from "ethers";
import { expect } from 'chai';
import { Action, Actor, RunContext, Snapshot } from "@svylabs/ilumia";

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
        // The `liquidate` function does not accept any parameters.
        // It retrieves the `safeId` from the `safesOrderedForLiquidation` queue.
        return [[], {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
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
        const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
        const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;

        const safesOrderedForLiquidationPrevious = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const safesOrderedForLiquidationNew = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

        const safesOrderedForRedemptionPrevious = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
        const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

        const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool;
        const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool;

        const dfireStakingPrevious = previousSnapshot.contractSnapshot.dfireStaking;
        const dfireStakingNew = newSnapshot.contractSnapshot.dfireStaking;

        // Fetch the safeId from the previous snapshot of the liquidation queue's tail
        const safeId = safesOrderedForLiquidationPrevious.tail;

        // Check if the safe existed in the previous snapshot
        const safePrevious = stableBaseCDPPrevious.safes[safeId];
        expect(safePrevious, `Safe with ID ${safeId} should exist in previous snapshot`).to.not.be.undefined;

        // 1. Safe Removal
        // Check that the Safe no longer exists in the `safes` mapping
        expect(stableBaseCDPNew.safes[safeId], `Safe with ID ${safeId} should not exist in the safes mapping after liquidation`).to.be.undefined;

        // Check removal from doubly linked lists
        expect(safesOrderedForLiquidationNew.nodes[safeId], `Safe should be removed from liquidation queue`).to.be.undefined;
        expect(safesOrderedForRedemptionNew.nodes[safeId], `Safe should be removed from redemption queue`).to.be.undefined;

        // 2. Global Debt and Collateral Consistency
        // Check that `totalCollateral` decreased by the original `collateralAmount`
        if (safePrevious) { // Ensure safePrevious exists
            const collateralAmount = safePrevious.collateralAmount;
            expect(stableBaseCDPNew.totalCollateral, 'totalCollateral should decrease by collateralAmount').to.equal(stableBaseCDPPrevious.totalCollateral - collateralAmount);

            // Check that `totalDebt` decreased by the original `borrowedAmount`
            const borrowedAmount = safePrevious.borrowedAmount;
            expect(stableBaseCDPNew.totalDebt, 'totalDebt should decrease by borrowedAmount').to.equal(stableBaseCDPPrevious.totalDebt - borrowedAmount);

            // Add more checks based on the specific logic of distributeDebtAndCollateral if secondary liquidation mechanism is used.

            // 3. Stability Pool State
            // Check that `totalStakedRaw` in the Stability Pool decreased by `borrowedAmount` if stability pool was used.
            // Check the `sbdToken` balance of the `stabilityPool` address decreased by `borrowedAmount`

            //determine whether or not the stability pool was used
            const stabilityPoolUsed = stabilityPoolPrevious.totalStakedRaw >= borrowedAmount

            if(stabilityPoolUsed){
                expect(stabilityPoolNew.totalStakedRaw, 'totalStakedRaw in StabilityPool should decrease by borrowedAmount').to.equal(stabilityPoolPrevious.totalStakedRaw - borrowedAmount);
                expect(dfidTokenNew.Balance[context.contracts.stabilityPool.target], 'sbdToken balance of StabilityPool should decrease by borrowedAmount').to.equal(dfidTokenPrevious.Balance[context.contracts.stabilityPool.target] - borrowedAmount);
            }

             // 5. ERC721 token
            //check balances for burned token
            expect(stableBaseCDPNew.balanceOf[actor.account.address]).to.be.equal(stableBaseCDPPrevious.balanceOf[actor.account.address] - BigInt(1));
            expect(stableBaseCDPNew.ownerOf[safeId]).to.be.undefined;
        }

        // 4. Fee Distribution
        // Check fee distribution based on events.
        // Check refund to `msg.sender`.


        // Add additional validation checks for state updates and events based on the action summary.
        return true;
    }
}