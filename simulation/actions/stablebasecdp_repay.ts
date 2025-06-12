import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from 'chai';
import {ethers} from 'ethers';

// Define constants from the StableBaseCDP contract
const MINIMUM_DEBT = 2000n * (10n ** 18n);
const PRECISION = 10n ** 18n;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * (10n ** 18n);

export class RepayAction extends Action {
    private stableBaseCDPContract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("RepayAction");
        this.stableBaseCDPContract = contract;
    }

    private simulateUpdateTotalDebt(
        currentDebt: bigint,
        delta: bigint,
        add: boolean,
        currentProtocolMode: number // 0 for BOOTSTRAP, 1 for NORMAL
    ): { newDebt: bigint; newProtocolMode: number } {
        let debt = currentDebt;
        if (add) {
            debt = currentDebt + delta;
        } else {
            debt = currentDebt - delta;
        }

        let newProtocolMode = currentProtocolMode;
        // Bootstrap Mode to Normal mode only once, Normal mode to bootstrap mode is not possible
        if (
            debt > BOOTSTRAP_MODE_DEBT_THRESHOLD &&
            currentProtocolMode === 0 // SBStructs.Mode.BOOTSTRAP is 0
        ) {
            newProtocolMode = 1; // SBStructs.Mode.NORMAL is 1
        }
        return { newDebt: debt, newProtocolMode: newProtocolMode };
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const actorAddress = actor.account.address;
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;

        const ownedSafes = Object.entries(stableBaseCDPSnapshot.safeOwner)
            .filter(([, ownerAddress]) => ownerAddress === actorAddress)
            .map(([safeId]) => BigInt(safeId));

        let availableSafeIds: bigint[] = [];

        for (const safeId of ownedSafes) {
            const safeDetails = stableBaseCDPSnapshot.safeDetails[safeId.toString()];
            // Ensure safe exists and has borrowed amount to repay
            if (safeDetails && safeDetails.borrowedAmount > 0n) {
                availableSafeIds.push(safeId);
            }
        }

        if (availableSafeIds.length === 0) {
            return [false, {}, {}]; // No repayable safes owned by actor
        }

        // Randomly select a safeId from available ones
        const safeIdIndex = Number(context.prng.next() % BigInt(availableSafeIds.length));
        const safeId = availableSafeIds[safeIdIndex];

        const currentBorrowedAmount = stableBaseCDPSnapshot.safeDetails[safeId.toString()].borrowedAmount;
        const actorSbdBalance = dfidTokenSnapshot.accountBalances[actorAddress];

        let potentialAmounts: bigint[] = [];

        // The condition `_safe.borrowedAmount - amount == 0 || _safe.borrowedAmount - amount >= MINIMUM_DEBT`
        // means the `amount` cannot be in the range `(currentBorrowedAmount - MINIMUM_DEBT, currentBorrowedAmount)`.

        // Option 1: Repay the full amount
        if (actorSbdBalance >= currentBorrowedAmount) {
            potentialAmounts.push(currentBorrowedAmount);
        }

        // Option 2: Partial repayment such that remaining debt is >= MINIMUM_DEBT
        // This means `amount <= currentBorrowedAmount - MINIMUM_DEBT`
        if (currentBorrowedAmount > MINIMUM_DEBT) {
            const maxForPartialRepay = currentBorrowedAmount - MINIMUM_DEBT;
            const actualMaxForPartialRepay = maxForPartialRepay > actorSbdBalance ? actorSbdBalance : maxForPartialRepay;

            if (actualMaxForPartialRepay >= 1n) {
                // Generate a random amount between 1n and actualMaxForPartialRepay (inclusive)
                const randomPartialAmount = (context.prng.next() % actualMaxForPartialRepay) + 1n;
                potentialAmounts.push(randomPartialAmount);
            }
        }

        // Remove duplicates and ensure at least one valid amount if possible
        potentialAmounts = [...new Set(potentialAmounts)];

        if (potentialAmounts.length === 0) {
            return [false, {}, {}]; // No valid repayment amount can be generated
        }

        const amountIndex = Number(context.prng.next() % BigInt(potentialAmounts.length));
        const amount = potentialAmounts[amountIndex];

        // Generate nearestSpotInLiquidationQueue (optional hint)
        let nearestSpotInLiquidationQueue = 0n;
        const liquidationNodes = Object.keys(currentSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes);
        if (liquidationNodes.length > 0 && context.prng.next() % 2n === 0n) { // 50% chance to provide a hint
            const randomIndex = Number(context.prng.next() % BigInt(liquidationNodes.length));
            nearestSpotInLiquidationQueue = BigInt(liquidationNodes[randomIndex]);
        }

        const actionParams = {
            safeId,
            amount,
            nearestSpotInLiquidationQueue,
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const signer = actor.account.value;
        const {safeId, amount, nearestSpotInLiquidationQueue} = actionParams;

        // Call the repay function on the StableBaseCDP contract
        const tx = await this.stableBaseCDPContract.connect(signer).repay(safeId, amount, nearestSpotInLiquidationQueue);
        const receipt = await tx.wait();

        return receipt;
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const {safeId, amount} = actionParams;
        const actorAddress = actor.account.address;

        // Get relevant snapshots
        const prevCdpSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newCdpSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
        const prevDfidTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
        const prevLiquidationQueueSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const newLiquidationQueueSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;
        const prevRedemptionQueueSnapshot = previousSnapshot.contractSnapshot.safesOrderedForRedemption;
        const newRedemptionQueueSnapshot = newSnapshot.contractSnapshot.safesOrderedForRedemption;

        // Get contract instances for event validation targets
        const dfidTokenContract = context.contracts.dfidToken as ethers.Contract;

        const txCost = executionReceipt.gasUsed * executionReceipt.gasPrice;

        let debtIncrease = 0n;
        let collateralIncrease = 0n;
        let safeUpdatedTriggered = false;

        // Determine if _updateSafe was triggered and extract its outputs from the event
        const safeUpdatedEvent = executionReceipt.events?.find(
            (event: any) =>
                event.address === this.stableBaseCDPContract.target && event.event === "SafeUpdated"
        );

        if (safeUpdatedEvent) {
            safeUpdatedTriggered = true;
            debtIncrease = safeUpdatedEvent.args.debtIncrease;
            collateralIncrease = safeUpdatedEvent.args.collateralIncrease;
        }

        // --- Simulate internal state changes for validation --- 
        const prevSafeDetails = prevCdpSnapshot.safeDetails[safeId.toString()];

        // 1. Simulate effects of _updateSafe on safe's borrowedAmount, collateralAmount, totalBorrowedAmount
        const expectedBorrowedAmountAfterUpdateSafe = prevSafeDetails.borrowedAmount + debtIncrease;
        const expectedCollateralAmountAfterUpdateSafe = prevSafeDetails.collateralAmount + collateralIncrease;
        const expectedTotalBorrowedAmount = prevSafeDetails.totalBorrowedAmount + debtIncrease;
        const expectedTotalCollateral = prevCdpSnapshot.totalCollateral + collateralIncrease;

        // Calculate expected borrowed amount after full repayment logic (after _updateSafe and repay amount deduction)
        const expectedBorrowedAmountAfterRepay = expectedBorrowedAmountAfterUpdateSafe - amount;

        // 2. Simulate _updateTotalDebt calls (one potentially from _updateSafe, one from repay)
        let simulatedTotalDebt = prevCdpSnapshot.totalDebt;
        let simulatedProtocolMode = prevCdpSnapshot.protocolMode; // Start with previous mode (0: BOOTSTRAP, 1: NORMAL)

        // First call to _updateTotalDebt from _updateSafe (if triggered)
        if (safeUpdatedTriggered) {
             const result = this.simulateUpdateTotalDebt(simulatedTotalDebt, debtIncrease, true, simulatedProtocolMode);
             simulatedTotalDebt = result.newDebt;
             simulatedProtocolMode = result.newProtocolMode;
        }
        
        // Second call to _updateTotalDebt from repay
        const result = this.simulateUpdateTotalDebt(simulatedTotalDebt, amount, false, simulatedProtocolMode);
        simulatedTotalDebt = result.newDebt;
        simulatedProtocolMode = result.newProtocolMode;

        const expectedTotalDebtFinal = simulatedTotalDebt;
        const expectedProtocolMode = simulatedProtocolMode;

        // 3. Calculate _newRatio based on final borrowed and collateral amounts
        let expectedNewRatio = 0n;
        if (expectedCollateralAmountAfterUpdateSafe > 0n) {
            expectedNewRatio = (expectedBorrowedAmountAfterRepay * PRECISION) / expectedCollateralAmountAfterUpdateSafe;
        }

        // --- State Validation --- 

        // StableBaseCDP contract state updates
        expect(newCdpSnapshot.safeDetails[safeId.toString()].borrowedAmount, "CDP borrowedAmount mismatch").to.equal(expectedBorrowedAmountAfterRepay);
        expect(newCdpSnapshot.safeDetails[safeId.toString()].totalBorrowedAmount, "CDP totalBorrowedAmount mismatch").to.equal(expectedTotalBorrowedAmount);
        expect(newCdpSnapshot.safeDetails[safeId.toString()].collateralAmount, "CDP collateralAmount mismatch").to.equal(expectedCollateralAmountAfterUpdateSafe);
        expect(newCdpSnapshot.totalCollateral, "StableBaseCDP totalCollateral mismatch").to.equal(expectedTotalCollateral);
        expect(newCdpSnapshot.totalDebt, "StableBaseCDP totalDebt mismatch").to.equal(expectedTotalDebtFinal);
        expect(newCdpSnapshot.protocolMode, "StableBaseCDP PROTOCOL_MODE mismatch").to.equal(expectedProtocolMode);

        // Validation for liquidationSnapshots (debtPerCollateralSnapshot and collateralPerCollateralSnapshot)
        // NOTE: The provided `StableBaseCDPSnapshot` interface does not include `liquidationSnapshots` as a direct property.
        // Therefore, we cannot directly validate `StableBaseCDP.liquidationSnapshots[safeId].collateralPerCollateralSnapshot`
        // and `StableBaseCDP.liquidationSnapshots[safeId].debtPerCollateralSnapshot` from the `newSnapshot`.
        // If these were available in the snapshot, the validation would look like:
        // if (safeUpdatedTriggered) {
        //     expect(newCdpSnapshot.liquidationSnapshots[safeId.toString()].collateralPerCollateralSnapshot, "CollateralPerCollateralSnapshot mismatch").to.equal(newCdpSnapshot.cumulativeCollateralPerUnitCollateral);
        //     expect(newCdpSnapshot.liquidationSnapshots[safeId.toString()].debtPerCollateralSnapshot, "DebtPerCollateralSnapshot mismatch").to.equal(newCdpSnapshot.cumulativeDebtPerUnitCollateral);
        // } else {
        //     // Assert no change if not triggered
        //     expect(newCdpSnapshot.liquidationSnapshots[safeId.toString()].collateralPerCollateralSnapshot, "CollateralPerCollateralSnapshot changed when not expected").to.equal(prevCdpSnapshot.liquidationSnapshots[safeId.toString()].collateralPerCollateralSnapshot);
        //     expect(newCdpSnapshot.liquidationSnapshots[safeId.toString()].debtPerCollateralSnapshot, "DebtPerCollateralSnapshot changed when not expected").to.equal(prevCdpSnapshot.liquidationSnapshots[safeId.toString()].debtPerCollateralSnapshot);
        // }

        // DFIDToken (SBD) contract state updates
        expect(newDfidTokenSnapshot.accountBalances[actorAddress], "Actor SBD balance mismatch").to.equal(prevDfidTokenSnapshot.accountBalances[actorAddress] - amount);
        expect(newDfidTokenSnapshot.tokenTotalSupply, "SBD totalSupply mismatch").to.equal(prevDfidTokenSnapshot.tokenTotalSupply - amount);
        expect(newDfidTokenSnapshot.totalTokensBurned, "SBD totalBurned mismatch").to.equal(prevDfidTokenSnapshot.totalTokensBurned + amount);

        // Actor ETH balance validation (assuming actor pays gas)
        expect(newSnapshot.accountSnapshot[actorAddress], "Actor ETH balance mismatch").to.equal(previousSnapshot.accountSnapshot[actorAddress] - txCost);

        // OrderedDoublyLinkedList state (safesOrderedForLiquidation, safesOrderedForRedemption)
        if (expectedNewRatio !== 0n) {
            // Safe should be present in liquidation queue with updated ratio
            expect(newLiquidationQueueSnapshot.nodes[safeId.toString()], "Safe not found in liquidation queue").to.exist;
            expect(newLiquidationQueueSnapshot.nodes[safeId.toString()].value, "Liquidation queue node value mismatch").to.equal(expectedNewRatio);
            // Safe should NOT be in redemption queue if it's still in liquidation queue (borrowedAmount > 0)
            expect(newRedemptionQueueSnapshot.nodes[safeId.toString()], "Safe found in redemption queue when it should not be").to.not.exist;
        } else {
            // Safe should be removed from both queues when debt is zero
            expect(newLiquidationQueueSnapshot.nodes[safeId.toString()], "Safe found in liquidation queue when it should be removed").to.not.exist;
            expect(newRedemptionQueueSnapshot.nodes[safeId.toString()], "Safe found in redemption queue when it should be removed").to.not.exist;
        }


        // --- Event Validation --- 

        const events = executionReceipt.events;
        expect(events, "No events emitted").to.not.be.null;

        // 1. Repaid event from StableBaseCDP
        const repaidEvent = events?.find(
            (event: any) =>
                event.address === this.stableBaseCDPContract.target && event.event === "Repaid"
        );
        expect(repaidEvent, "Repaid event not emitted").to.exist;
        expect(repaidEvent?.args.safeId, "Repaid event safeId mismatch").to.equal(safeId);
        expect(repaidEvent?.args.amount, "Repaid event amount mismatch").to.equal(amount);
        expect(repaidEvent?.args.newRatio, "Repaid event newRatio mismatch").to.equal(expectedNewRatio);
        expect(repaidEvent?.args.totalCollateral, "Repaid event totalCollateral mismatch").to.equal(newCdpSnapshot.totalCollateral);
        expect(repaidEvent?.args.totalDebt, "Repaid event totalDebt mismatch").to.equal(newCdpSnapshot.totalDebt);


        // 2. Burn event from DFIDToken (SBD token)
        const burnEvent = events?.find(
            (event: any) =>
                event.address === dfidTokenContract.target && event.event === "Burn"
        );
        expect(burnEvent, "Burn event not emitted").to.exist;
        expect(burnEvent?.args.from, "Burn event 'from' address mismatch").to.equal(actorAddress);
        expect(burnEvent?.args.amount, "Burn event amount mismatch").to.equal(amount);

        // 3. Transfer event from DFIDToken (SBD token) to address(0)
        const transferToZeroEvent = events?.find(
            (event: any) =>
                event.address === dfidTokenContract.target &&
                event.event === "Transfer" &&
                event.args.to === ethers.constants.AddressZero
        );
        expect(transferToZeroEvent, "Transfer to address(0) event not emitted").to.exist;
        expect(transferToZeroEvent?.args.from, "Transfer event 'from' address mismatch").to.equal(actorAddress);
        expect(transferToZeroEvent?.args.to, "Transfer event 'to' address mismatch").to.equal(ethers.constants.AddressZero);
        expect(transferToZeroEvent?.args.value, "Transfer event value mismatch").to.equal(amount);

        // 4. SafeUpdated event (conditional)
        if (safeUpdatedTriggered) {
            const safeUpdatedEvt = events?.find(
                (event: any) =>
                    event.address === this.stableBaseCDPContract.target && event.event === "SafeUpdated"
            );
            expect(safeUpdatedEvt, "SafeUpdated event not emitted when expected").to.exist;
            expect(safeUpdatedEvt?.args._safeId, "SafeUpdated event _safeId mismatch").to.equal(safeId);
            expect(safeUpdatedEvt?.args.collateralAmount, "SafeUpdated event collateralAmount mismatch").to.equal(newCdpSnapshot.safeDetails[safeId.toString()].collateralAmount);
            expect(safeUpdatedEvt?.args.borrowedAmount, "SafeUpdated event borrowedAmount mismatch").to.equal(newCdpSnapshot.safeDetails[safeId.toString()].borrowedAmount);
            expect(safeUpdatedEvt?.args.collateralIncrease, "SafeUpdated event collateralIncrease mismatch").to.equal(collateralIncrease);
            expect(safeUpdatedEvt?.args.debtIncrease, "SafeUpdated event debtIncrease mismatch").to.equal(debtIncrease);
            expect(safeUpdatedEvt?.args.totalCollateral, "SafeUpdated event totalCollateral mismatch").to.equal(newCdpSnapshot.totalCollateral);
            expect(safeUpdatedEvt?.args.totalDebt, "SafeUpdated event totalDebt mismatch").to.equal(newCdpSnapshot.totalDebt);
        } else {
            const safeUpdatedEvt = events?.find(
                (event: any) =>
                    event.address === this.stableBaseCDPContract.target && event.event === "SafeUpdated"
            );
            expect(safeUpdatedEvt, "SafeUpdated event emitted when not expected").to.not.exist;
        }

        // 5. LiquidationQueueUpdated or SafeRemovedFromQueue events (conditional on newRatio)
        if (expectedNewRatio !== 0n) {
            const liquidationQueueUpdatedEvent = events?.find(
                (event: any) =>
                    event.address === this.stableBaseCDPContract.target && event.event === "LiquidationQueueUpdated"
            );
            expect(liquidationQueueUpdatedEvent, "LiquidationQueueUpdated event not emitted when expected").to.exist;
            expect(liquidationQueueUpdatedEvent?.args.safeId, "LiquidationQueueUpdated event safeId mismatch").to.equal(safeId);
            expect(liquidationQueueUpdatedEvent?.args.newRatio, "LiquidationQueueUpdated event newRatio mismatch").to.equal(expectedNewRatio);
        } else {
            const safeRemovedFromLiquidationQueueEvent = events?.find(
                (event: any) =>
                    event.address === this.stableBaseCDPContract.target && event.event === "SafeRemovedFromLiquidationQueue"
            );
            expect(safeRemovedFromLiquidationQueueEvent, "SafeRemovedFromLiquidationQueue event not emitted when expected").to.exist;
            expect(safeRemovedFromLiquidationQueueEvent?.args.safeId, "SafeRemovedFromLiquidationQueue event safeId mismatch").to.equal(safeId);

            const safeRemovedFromRedemptionQueueEvent = events?.find(
                (event: any) =>
                    event.address === this.stableBaseCDPContract.target && event.event === "SafeRemovedFromRedemptionQueue"
            );
            expect(safeRemovedFromRedemptionQueueEvent, "SafeRemovedFromRedemptionQueue event not emitted when expected").to.exist;
            expect(safeRemovedFromRedemptionQueueEvent?.args.safeId, "SafeRemovedFromRedemptionQueue event safeId mismatch").to.equal(safeId);
        }

        return true;
    }
}
