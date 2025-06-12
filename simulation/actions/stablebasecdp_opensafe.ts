import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class OpensafeAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("OpenSafeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot: any = currentSnapshot.contractSnapshot.stableBaseCDP;

        // Generate a unique safeId
        let safeId: bigint;
        let attempts = 0;
        const maxAttempts = 100;
        do {
            safeId = BigInt(context.prng.next());
            attempts++;
            if (attempts > maxAttempts) {
                console.warn("Could not generate unique safeId after " + maxAttempts + " attempts.");
                return [false, {}, {}];
            }
        } while (stableBaseCDPSnapshot.safeOwners[safeId.toString()] !== undefined || safeId <= 0n);

        // Generate a random amount for the collateral deposit
        const maxCollateral = currentSnapshot.accountSnapshot[actor.account.address] || 0n;
        if (maxCollateral <= 0n) {
            console.warn("Account has insufficient ETH to open a Safe.");
            return [false, {}, {}];
        }
        const amount = BigInt(context.prng.next()) % maxCollateral + 1n; // Ensure amount > 0

        const params = {
            _safeId: safeId,
            _amount: amount,
        };

        const newIdentifiers: Record<string, any> = {
            safeId: safeId.toString(),
        };

        return [true, params, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { _safeId, _amount } = actionParams;

        const tx = await this.contract.connect(actor.account.value).openSafe(_safeId, _amount, { value: _amount });
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
        const { _safeId, _amount } = actionParams;

        const prevStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
        const prevAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || 0n;
        const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || 0n;

        // Safe Existence
        expect(newStableBaseCDPSnapshot.safesData[_safeId.toString()]).to.not.be.undefined; //Check that a new Safe is created
        expect(newStableBaseCDPSnapshot.safesData[_safeId.toString()].collateralAmount).to.equal(_amount, "Collateral amount mismatch");
        expect(newStableBaseCDPSnapshot.safesData[_safeId.toString()].borrowedAmount).to.equal(0n, "Borrowed amount mismatch");
        expect(newStableBaseCDPSnapshot.liquidationSnapshotsData[_safeId.toString()].debtPerCollateralSnapshot).to.equal(newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral, "debtPerCollateralSnapshot mismatch");
        expect(newStableBaseCDPSnapshot.liquidationSnapshotsData[_safeId.toString()].collateralPerCollateralSnapshot).to.equal(newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral, "collateralPerCollateralSnapshot mismatch");

        // Total Collateral
        expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(prevStableBaseCDPSnapshot.totalCollateral + _amount, "Total collateral mismatch");

        // NFT Ownership
        expect(newStableBaseCDPSnapshot.safeOwners[_safeId.toString()]).to.equal(actor.account.address, "NFT ownership mismatch");

        // Balances
        expect(newAccountBalance).to.equal(prevAccountBalance - _amount - executionReceipt.receipt.gasUsed * executionReceipt.receipt.effectiveGasPrice, "Account balance mismatch");

        // Additional checks (optional, but recommended)
        expect(newStableBaseCDPSnapshot.balances[actor.account.address]).to.gt(0n, "The balance of the msg.sender should be greater than 0");

        return true;
    }
} 
