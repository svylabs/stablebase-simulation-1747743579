import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

export class OpenSafeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super('OpenSafeAction');
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        // Generate _safeId: This needs to be a unique ID.
        // Since there is max_identifier_limit_per_address. Use it
        const existingSafeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes).map(Number);
        let _safeId: number;
        let attempts = 0;
        const maxSafeIds = 100; // use action_execution.new_identifiers[0].max_identifier_limit_per_address
        do {
            _safeId = Math.floor(context.prng.next() % maxSafeIds) + 1; // Ensure _safeId is greater than 0
            attempts++;
            if (attempts > maxSafeIds * 2) {
                throw new Error('Failed to generate a unique _safeId after multiple attempts.');
            }
        } while (existingSafeIds.includes(_safeId));

        // Generate _amount: Amount of collateral to deposit. It should be a positive value in wei.
        const _amount = ethers.BigNumber.from(Math.floor(context.prng.next() % 1000) + 1); // Up to 1000 wei, always positive

        const actionParams = [_safeId, _amount];
        const newIdentifiers = { _safeId: _safeId };

        return [actionParams, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const _safeId = actionParams[0] as number;
        const _amount = actionParams[1] as ethers.BigNumber;

        const tx = await this.contract.connect(actor.account.value).openSafe(_safeId, _amount, { value: _amount });
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const _safeId = actionParams[0] as number;
        const _amount = ethers.BigNumber.from(actionParams[1]);

        const prevStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        // Verify Safe State
        expect(newStableBaseCDPSnapshot.safes[_safeId].collateralAmount).to.eql(_amount, 'Collateral amount should match the deposited amount.');
        expect(newStableBaseCDPSnapshot.safes[_safeId].borrowedAmount).to.eql(ethers.BigNumber.from(0), 'Borrowed amount should be 0.');
        expect(newStableBaseCDPSnapshot.safes[_safeId].weight).to.eql(ethers.BigNumber.from(0), 'Weight should be 0.');
        expect(newStableBaseCDPSnapshot.safes[_safeId].totalBorrowedAmount).to.eql(ethers.BigNumber.from(0), 'Total borrowed amount should be 0.');
        expect(newStableBaseCDPSnapshot.safes[_safeId].feePaid).to.eql(ethers.BigNumber.from(0), 'Fee paid should be 0.');
        expect(newStableBaseCDPSnapshot.liquidationSnapshots[_safeId].debtPerCollateralSnapshot).to.eql(newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral, 'Debt per collateral snapshot should match cumulative debt per unit collateral.');
        expect(newStableBaseCDPSnapshot.liquidationSnapshots[_safeId].collateralPerCollateralSnapshot).to.eql(newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral, 'Collateral per collateral snapshot should match cumulative collateral per unit collateral.');

        // Verify NFT Ownership
        expect(newStableBaseCDPSnapshot.owners[_safeId]).to.eql(actor.account.address, 'Owner of the Safe (NFT) should be the actor.');

        // Verify Global State
        const totalCollateralIncrease = newStableBaseCDPSnapshot.totalCollateral.sub(prevStableBaseCDPSnapshot.totalCollateral);
        expect(totalCollateralIncrease).to.eql(_amount, 'Total collateral should have increased by the deposited amount.');

        return true;
    }
}