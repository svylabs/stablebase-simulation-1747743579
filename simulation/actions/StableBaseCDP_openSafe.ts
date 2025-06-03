import { Actor, RunContext, Snapshot, Account, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

export class OpenSafeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("OpenSafeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        let _safeId: bigint;
        let _amount: bigint;

        // Generate a `_safeId` greater than 0 that does not already exist.
        while (true) {
            _safeId = BigInt(context.prng.next()) % BigInt(10000) + BigInt(1);
            const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId];
            const owner = currentSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId];
            if ((safe === undefined || (safe && safe.collateralAmount === BigInt(0))) && (owner === undefined || owner === ethers.constants.AddressZero)) {
                break;
            }
        }

        // Generate an `_amount` greater than 0.  The `msg.value` must equal this `_amount`.
        const maxEth = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        _amount = BigInt(context.prng.next()) % (maxEth > BigInt(100) ? BigInt(100) : maxEth > BigInt(0) ? maxEth : BigInt(1)) + BigInt(1);

        const params = [
            _safeId,
            _amount
        ];

        const newIdentifiers: Record<string, any> = {
            _safeId: _safeId
        };

        return [params, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const _safeId = actionParams[0];
        const _amount = actionParams[1];

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
        const _safeId = actionParams[0];
        const _amount = actionParams[1];

        // Verify that the `safes[_safeId].collateralAmount` is equal to the `_amount` provided.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId]?.collateralAmount || BigInt(0)).to.equal(_amount);

        // Verify that `safes[_safeId].borrowedAmount` is 0.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId]?.borrowedAmount || BigInt(0)).to.equal(BigInt(0));

        // Verify that `safes[_safeId].weight` is 0.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId]?.weight || BigInt(0)).to.equal(BigInt(0));

        // Verify that `safes[_safeId].totalBorrowedAmount` is 0.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId]?.totalBorrowedAmount || BigInt(0)).to.equal(BigInt(0));

        // Verify that `safes[_safeId].feePaid` is 0.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safes[_safeId]?.feePaid || BigInt(0)).to.equal(BigInt(0));

        // Verify that `liquidationSnapshots[_safeId].debtPerCollateralSnapshot` is equal to `cumulativeDebtPerUnitCollateral`.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId]?.debtPerCollateralSnapshot || BigInt(0)).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral);

        // Verify that `liquidationSnapshots[_safeId].collateralPerCollateralSnapshot` is equal to `cumulativeCollateralPerUnitCollateral`.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[_safeId]?.collateralPerCollateralSnapshot || BigInt(0)).to.equal(newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral);

        // Verify that `_ownerOf(_safeId)` returns `msg.sender`.
        expect(newSnapshot.contractSnapshot.stableBaseCDP.owners[_safeId] || ethers.constants.AddressZero).to.equal(actor.account.address);

        // Verify that `totalCollateral` has increased by `_amount`.
        expect((newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0)) - (previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0))).to.equal(_amount);

        // TODO: Verify that a `OpenSafe` event is emitted with the correct parameters (`_safeId`, `msg.sender`, `_amount`, `totalCollateral`, `totalDebt`).
        // Getting events is currently not supported but should be supported soon.

        return true;
    }
}
