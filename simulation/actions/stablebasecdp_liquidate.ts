import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class LiquidateAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("LiquidateAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safesOrderedForLiquidationSnapshot = currentSnapshot.contractSnapshot.safesOrderedForLiquidation;

        if (safesOrderedForLiquidationSnapshot.tail === BigInt(0)) {
            // No safe to liquidate
            return [false, {}, {}];
        }

        // Check if msg.sender has sufficient balance for gas is implicitly handled by hardhat

        // Other pre-execution checks are assumed to pass based on the action summary.  In a real-world scenario, these checks should be explicitly implemented using snapshots or on-chain data.

        return [true, {}, {}];
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

        const safesOrderedForRedemptionNew = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        // Get the safeId that was liquidated by looking at the previous tail
        const safeId = safesOrderedForLiquidationPrevious.tail;

        const previousSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safes[safeId.toString()];

        // Safe validations
        if(previousSafe) {
          const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId.toString()];
          expect(newSafe).to.be.undefined; // safes[_safeId] does not exist
        }
        expect(safesOrderedForLiquidationNew.tail).to.not.equal(safeId); // _safeId is not in safesOrderedForLiquidation
        expect(safesOrderedForRedemptionNew.nodes[safeId.toString()]).to.be.undefined; // _safeId is not in safesOrderedForRedemption

        // Protocol validations
        if(previousSafe) {
          const borrowedAmount = previousSafe.borrowedAmount;
          const collateralAmount = previousSafe.collateralAmount;

          expect(stableBaseCDPNew.totalCollateral).to.equal(stableBaseCDPPrevious.totalCollateral - collateralAmount); // totalCollateral decreased by liquidated safe's collateralAmount
          expect(stableBaseCDPNew.totalDebt).to.equal(stableBaseCDPPrevious.totalDebt - borrowedAmount); // totalDebt decreased by liquidated safe's borrowedAmount

          const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
          const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;
          const stabilityPoolAddress = (context.contracts.stabilityPool as any).target;

          if (borrowedAmount <= previousSnapshot.contractSnapshot.stabilityPool.totalStakedRaw) {
              expect(dfidTokenNew.balances[stabilityPoolAddress]).to.equal(dfidTokenPrevious.balances[stabilityPoolAddress] - borrowedAmount);
              expect(dfidTokenNew.totalSupply).to.equal(dfidTokenPrevious.totalSupply - borrowedAmount);
              expect(dfidTokenNew.totalBurned).to.equal(dfidTokenPrevious.totalBurned + borrowedAmount);
          }
        }

        // ERC721 validations - not accessible at snapshot level

        // Invariant validations
        expect(stableBaseCDPNew.totalCollateral).to.be.at.least(0);
        expect(stableBaseCDPNew.totalDebt).to.be.at.least(0);

         // Event validations (example - adjust as needed, may require parsing logs)
         // Assuming the event is named 'LiquidatedUsingStabilityPool'
         // const event = executionReceipt.receipt.logs.find(log => log.name === 'LiquidatedUsingStabilityPool');
         // expect(event).to.not.be.undefined;

        return true;
    }
}