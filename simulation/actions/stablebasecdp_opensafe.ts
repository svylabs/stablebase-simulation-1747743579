import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class OpenSafeAction extends Action {
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
        // Get the StableBaseCDP snapshot for state checks
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

        let _safeId: bigint;
        let attempts = 0;
        const maxAttempts = 100; // Avoid infinite loops

        // Generate a unique _safeId
        do {
            _safeId = BigInt(Math.floor(context.prng.next() % 1000000) + 1); // Ensure _safeId is positive
            attempts++;
            if (attempts > maxAttempts) {
                console.warn("Could not find a unique safeId after several attempts.");
                return [false, {}, {}]; // Or throw an error if appropriate
            }
            // Check if _safeId already exists in safes mapping or as a token owned by the contract
        } while (
            stableBaseCDPSnapshot.safes[_safeId.toString()]?.collateralAmount !== undefined ||
            (currentSnapshot.accountSnapshot[this.contract.target]?.balances?.[_safeId.toString()] !== undefined &&
             (currentSnapshot.accountSnapshot[this.contract.target]?.balances?.[_safeId.toString()] || BigInt(0)) > BigInt(0))
        );

        // Get the maximum ETH balance available for the actor
        const maxEth: bigint = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        // If the actor has no ETH, return false
        if (maxEth <= BigInt(0)) {
            return [false, {}, {}];
        }

        // Generate a random amount of ETH to deposit
        const _amount: bigint = BigInt(Math.floor(context.prng.next() % Number(maxEth)) + 1); // Ensure _amount is positive

        // Check if the action can be executed
        const canExecute: boolean = _amount > BigInt(0);

        // Prepare the action parameters
        const actionParams = {
            _safeId: _safeId,
            _amount: _amount,
            value: _amount // msg.value
        };

        // Prepare the new identifiers
        const newIdentifiers: Record<string, string> = {
            _safeId: _safeId.toString()
        };

        return [canExecute, actionParams, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { _safeId, _amount, value } = actionParams;

        // Execute the openSafe function
        const tx = await this.contract.connect(actor.account.value).openSafe(_safeId, _amount, { value: value });
        return tx.wait();
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
        const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
        const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;

        // Safe Data
        expect(stableBaseCDPNew.safes[_safeId].collateralAmount).to.equal(_amount, "safes[_safeId].collateralAmount should be equal to _amount");
        expect(stableBaseCDPNew.safes[_safeId].borrowedAmount).to.equal(BigInt(0), "safes[_safeId].borrowedAmount should be 0");
        expect(stableBaseCDPNew.safes[_safeId].weight).to.equal(BigInt(0), "safes[_safeId].weight should be 0");
        expect(stableBaseCDPNew.safes[_safeId].totalBorrowedAmount).to.equal(BigInt(0), "safes[_safeId].totalBorrowedAmount should be 0");
        expect(stableBaseCDPNew.safes[_safeId].feePaid).to.equal(BigInt(0), "safes[_safeId].feePaid should be 0");
        expect(stableBaseCDPNew.debtPerCollateralSnapshot[_safeId]).to.equal(stableBaseCDPNew.cumulativeDebtPerUnitCollateral, "liquidationSnapshots[_safeId].debtPerCollateralSnapshot should be equal to cumulativeDebtPerUnitCollateral");
        expect(stableBaseCDPNew.collateralPerCollateralSnapshot[_safeId]).to.equal(stableBaseCDPNew.cumulativeCollateralPerUnitCollateral, "liquidationSnapshots[_safeId].collateralPerCollateralSnapshot should be equal to cumulativeCollateralPerUnitCollateral");

        // Accounting
        expect(stableBaseCDPNew.totalCollateral - stableBaseCDPPrevious.totalCollateral).to.equal(_amount, "totalCollateral should be increased by _amount");

        // NFT Ownership - Assuming _ownerOf function exists in the contract
        const ownerOf = await this.contract._ownerOf(_safeId);
        expect(ownerOf).to.equal(actor.account.address, "ownerOf(_safeId) should be equal to msg.sender");

        // Events - Can't directly validate events, but can check if the transaction was successful
        expect(executionReceipt.status).to.equal(1, "Transaction should be successful");

        // Account Balances - Assuming ETH balances
        const previousEthBalance: bigint = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newEthBalance: bigint = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        expect(previousEthBalance - newEthBalance).to.equal(_amount, "ETH balance should be decreased by _amount");

        return true;
    }
}
