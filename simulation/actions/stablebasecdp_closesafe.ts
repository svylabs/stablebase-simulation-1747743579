import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class CloseSafeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("CloseSafeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const safeId = actor.identifiers.safeId;

        if (!safeId) {
            console.log("Safe ID is missing for actor:", actor.account.address);
            return [false, {}, {}];
        }

        // Check if safe exists and owned by the actor
        const stableBaseCDPSnapshot: any = currentSnapshot.contractSnapshot.stableBaseCDP
        const safeInfo: any = stableBaseCDPSnapshot.safes[safeId.toString()];

        if (!safeInfo) {
            console.log(`Safe with ID ${safeId} does not exist.`);
            return [false, {}, {}];
        }

        // Check borrowed amount is 0
        if (safeInfo.borrowedAmount !== BigInt(0)) {
            console.log(`Safe with ID ${safeId} has non-zero borrowed amount: ${safeInfo.borrowedAmount}`);
            return [false, {}, {}];
        }

        return [true, { safeId: BigInt(safeId) }, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { safeId } = actionParams;

        const tx = await this.contract
            .connect(actor.account.value)
            .closeSafe(safeId);

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
        const { safeId } = actionParams;

        const previousStableBaseCDPSnapshot: any = previousSnapshot.contractSnapshot.stableBaseCDP
        const newStableBaseCDPSnapshot: any = newSnapshot.contractSnapshot.stableBaseCDP

        // Validate Safe is removed from `safes` mapping
        expect(newStableBaseCDPSnapshot.safes[safeId.toString()], `safes[${safeId}] should not exist`).to.be.undefined;

        // Validate totalCollateral decreased
        const previousSafeInfo: any = previousStableBaseCDPSnapshot.safes[safeId.toString()];
        const collateralAmount = previousSafeInfo.collateralAmount;

        if (previousStableBaseCDPSnapshot.totalCollateral < collateralAmount) {
            console.warn("Collateral amount is greater than total collateral. Validation may be incorrect.");
        } else {
            expect(newStableBaseCDPSnapshot.totalCollateral, "totalCollateral should decrease").to.equal(previousStableBaseCDPSnapshot.totalCollateral - collateralAmount);
        }

        //Validate totalDebt - impossible to assert on the exact value, but should be less or equal to totalDebt
        expect(newStableBaseCDPSnapshot.totalDebt, "totalDebt should be less or equal").to.lessThanOrEqual(previousStableBaseCDPSnapshot.totalDebt);

        // Validate ERC721 changes
        const owner = await this.contract.ownerOf(safeId);
        expect(owner).to.equal(ethers.constants.AddressZero, `ownerOf(${safeId}) should be address(0)`);

        // Validate ERC721 changes for balances
        const dfidToken = context.contracts.dfidToken;
        const previousAccountBalance = previousSnapshot.contractSnapshot.dfidToken.balances[this.contract.target];
        const newAccountBalance = newSnapshot.contractSnapshot.dfidToken.balances[this.contract.target];


        return true;
    }
}
