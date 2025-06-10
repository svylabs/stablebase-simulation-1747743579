import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

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
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        if (!stableBaseCDPSnapshot) {
            return [false, {}, {}];
        }

        // Check if safeInfo exists before accessing its properties
        if (!stableBaseCDPSnapshot.safeInfo) {
            return [false, {}, {}];
        }

        const safeIds = Object.keys(stableBaseCDPSnapshot.safeInfo);
        if (safeIds.length === 0) {
            return [false, {}, {}];
        }

        // Find a Safe owned by the actor with a borrowedAmount of 0
        let safeIdToClose: string | undefined;
        const validSafeIds: string[] = [];

        for (const safeId of safeIds) {
            try {
                const owner = await this.contract.ownerOf(safeId);
                if (owner.toLowerCase() === actor.account.address.toLowerCase()) {
                    if (stableBaseCDPSnapshot.safeInfo[safeId].borrowedAmount === BigInt(0)) {
                        validSafeIds.push(safeId);
                    }
                }
            } catch (e) {
                // If safe doesn't exist onchain
                continue;
            }
        }

        if (validSafeIds.length === 0) {
            return [false, {}, {}];
        }

        // Randomly select a safeId from the valid safeIds
        const randomIndex = Math.floor(context.prng.next() % BigInt(validSafeIds.length).valueOf());
        safeIdToClose = validSafeIds[randomIndex];

        const actionParams = {
            safeId: BigInt(safeIdToClose),
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const signer = actor.account.value.connect(this.contract.provider);
        const tx = await this.contract.connect(signer).closeSafe(actionParams.safeId);
        return { txHash: tx.hash };
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

        const previousAccountSnapshot = previousSnapshot.accountSnapshot;
        const newAccountSnapshot = newSnapshot.accountSnapshot;

        if (!previousStableBaseCDPSnapshot || !newStableBaseCDPSnapshot) {
            console.error("StableBaseCDP snapshot not available");
            return false;
        }

        if (!previousAccountSnapshot || !newAccountSnapshot) {
            console.error("Account snapshot not available");
            return false;
        }

        // Safe Closure Validation
        expect(newStableBaseCDPSnapshot.safeInfo[safeId]).to.be.undefined;

        // Total Collateral Update Validation
        const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
        const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
        const collateralAmount = previousStableBaseCDPSnapshot.safeInfo[safeId].collateralAmount;
        expect(newTotalCollateral).to.equal(previousTotalCollateral - collateralAmount, "Total collateral should be decreased by the collateral amount of the closed Safe.");

        // Total Debt Update Validation
        const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
        const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;
        expect(newTotalDebt).to.equal(previousTotalDebt, "Total debt should remain unchanged.");

        // Collateral Transfer Validation
        const previousAccountBalance = previousAccountSnapshot[actor.account.address] || BigInt(0);
        const newAccountBalance = newAccountSnapshot[actor.account.address] || BigInt(0);

        expect(newAccountBalance).to.equal(previousAccountBalance + collateralAmount, "Account balance should increase by the collateral amount.");

        // Additional check: ERC721 token should be burned (ownership transferred to address(0))
        try {
            await this.contract.ownerOf(safeId);
            expect.fail("Expected Safe NFT to be burned (nonexistent), but it still exists");
        } catch (error: any) {
            expect(error.message).to.include("ERC721: owner query for nonexistent token");
        }

        // Validate state changes across affected contracts
        // Since closeSafe only directly affects StableBaseCDP and potentially the actor's account,
        // no additional contract state changes need to be validated in this example.

        return true;
    }
}
