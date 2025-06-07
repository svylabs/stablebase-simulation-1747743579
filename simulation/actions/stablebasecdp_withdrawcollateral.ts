import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";

export class WithdrawCollateralAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("WithdrawCollateralAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);

        if (safeIds.length === 0) {
            throw new Error("No safes available to withdraw from.");
        }

        let safeId: number;
        let safe: any;
        let amount: bigint;
        let nearestSpotInLiquidationQueue: number;

        for (let i = 0; i < 5; i++) {
            safeId = safeIds[context.prng.next() % safeIds.length];
            safe = stableBaseCDPSnapshot.safes[BigInt(safeId)];

            if (stableBaseCDPSnapshot.ownerOf[BigInt(safeId)] === actor.account.address && safe.collateralAmount > BigInt(0)) {
                // Ensure amount is within the bounds of available collateral
                if (safe.collateralAmount > BigInt(0)) {
                    amount = BigInt(context.prng.next()) % safe.collateralAmount + BigInt(1);
                } else {
                    amount = BigInt(0);
                }

                nearestSpotInLiquidationQueue = 0; // Default value

                return [
                    [BigInt(safeId), amount, BigInt(nearestSpotInLiquidationQueue)],
                    {}
                ];
            }
        }

        throw new Error("No suitable safe found for withdrawal after multiple attempts.");
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const [safeId, amount, nearestSpotInLiquidationQueue] = actionParams;
        return await this.contract
            .connect(actor.account.value)
            .withdrawCollateral(safeId, amount, nearestSpotInLiquidationQueue);
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const [safeId, amount, nearestSpotInLiquidationQueue] = actionParams;

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
        const newSafe = newStableBaseCDPSnapshot.safes[safeId];

        const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
        const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
        const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt
        const newTotalDebt = newStableBaseCDPSnapshot.totalDebt

        // Collateral Balance Validation
        expect(newSafe.collateralAmount).to.equal(previousSafe.collateralAmount - amount, "Safe's collateral amount should decrease by the withdrawn amount.");
        expect(newTotalCollateral).to.equal(previousTotalCollateral - amount, "Total collateral should decrease by the withdrawn amount.");

        //Event Emission Validation
        const events = newSnapshot.events;
        if(events && events.length > 0) {
            const withdrawCollateralEvent = events.find(event => event.name === "WithdrawnCollateral" && event.args.safeId.toString() === safeId.toString());
            expect(withdrawCollateralEvent).to.not.be.undefined;
            expect(withdrawCollateralEvent.args.safeId).to.equal(safeId);
            expect(withdrawCollateralEvent.args.amount).to.equal(amount);
            expect(withdrawCollateralEvent.args.totalCollateral).to.equal(newTotalCollateral);
            expect(withdrawCollateralEvent.args.totalDebt).to.equal(newTotalDebt);
        }

        //Collateral Transfer Success
        const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address];
        const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address];
        expect(newAccountBalance - previousAccountBalance).to.equal(amount, "Account balance should increase by the withdrawn amount");

        // Debt is validated here since totalDebt could be changed
        expect(newTotalDebt).to.lte(previousTotalDebt, "Total debt cannot increase during collateral withdrawal.");

        return true;
    }
}
