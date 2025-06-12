import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from 'chai';
import {ethers} from "ethers";

// Define constants
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * 10n**18n;

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
        const actorAddress = actor.account.address;

        let suitableSafeId: bigint | undefined;

        // Iterate through existing safes to find one owned by the actor with zero borrowed amount
        for (const safeIdStr in stableBaseCDPSnapshot.safeDetails) {
            const safeId = BigInt(safeIdStr);
            const safeDetail = stableBaseCDPSnapshot.safeDetails[safeIdStr];
            const safeOwner = stableBaseCDPSnapshot.safeOwner[safeIdStr];

            if (safeOwner === actorAddress && safeDetail.borrowedAmount === 0n) {
                // Pre-execution validation: Safe must be owned by msg.sender and have borrowedAmount of 0
                suitableSafeId = safeId;
                break;
            }
        }

        if (suitableSafeId !== undefined) {
            return [true, { safeId: suitableSafeId }, {}];
        } else {
            context.log.info(`No suitable safe found for actor ${actorAddress} to close.`);
            return [false, {}, {}];
        }
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { safeId } = actionParams;
        context.log.info(`Executing CloseSafe for safeId: ${safeId}`);
        const signer = actor.account.value;
        const connectedContract = this.contract.connect(signer);
        const tx = await connectedContract.closeSafe(safeId);
        const receipt = await tx.wait();
        if (!receipt) {
            throw new Error("Transaction receipt is null");
        }
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
        const { safeId } = actionParams;
        const actorAddress = actor.account.address;
        const contractAddress = this.contract.target as string;

        context.log.info(`Validating CloseSafe for safeId: ${safeId}`);

        // --- 1. Extract Event Data ---
        const safeClosedEvent = executionReceipt.events?.find(
            (event) => event.eventName === "SafeClosed"
        );
        const removedSafeEvent = executionReceipt.events?.find(
            (event) => event.eventName === "RemovedSafe"
        );
        const transferEvent = executionReceipt.events?.find(
            (event) =>
                event.eventName === "Transfer" &&
                event.args.from === actorAddress &&
                event.args.to === ethers.ZeroAddress &&
                BigInt(event.args.tokenId) === safeId
        );
        const safeUpdatedEvent = executionReceipt.events?.find(
            (event) => event.eventName === "SafeUpdated"
        );

        expect(safeClosedEvent, "SafeClosed event must be emitted").to.exist;
        expect(removedSafeEvent, "RemovedSafe event must be emitted").to.exist;
        expect(transferEvent, "ERC721 Transfer event must be emitted").to.exist;

        const refundedCollateral = BigInt(safeClosedEvent!.args.refundedCollateral);
        const finalTotalCollateral = BigInt(safeClosedEvent!.args.totalCollateral);
        const finalTotalDebt = BigInt(safeClosedEvent!.args.totalDebt);

        let debtIncreaseFromUpdate = 0n;
        let collateralIncreaseFromUpdate = 0n;
        let safeStateAfterUpdate: {
            collateralAmount: bigint;
            borrowedAmount: bigint;
            weight: bigint;
            totalBorrowedAmount: bigint;
            feePaid: bigint;
        };

        if (safeUpdatedEvent) {
            collateralIncreaseFromUpdate = BigInt(safeUpdatedEvent.args.collateralIncrease);
            debtIncreaseFromUpdate = BigInt(safeUpdatedEvent.args.debtIncrease);
            safeStateAfterUpdate = {
                collateralAmount: BigInt(safeUpdatedEvent.args._safeCollateralAmount),
                borrowedAmount: BigInt(safeUpdatedEvent.args._safeBorrowedAmount),
                weight: BigInt(previousSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()].weight), // Weight is not changed by _updateSafe, take from previous snapshot
                totalBorrowedAmount: BigInt(safeUpdatedEvent.args._safeTotalBorrowedAmount),
                feePaid: BigInt(previousSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()].feePaid), // FeePaid is not changed by _updateSafe, take from previous snapshot
            };
        } else {
            // If SafeUpdated event is not emitted, it means no changes occurred in _updateSafe
            safeStateAfterUpdate = previousSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()];
        }

        // --- 2. Initial Snapshot Values ---
        const prevSafeDetails = previousSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()];
        const prevOwnerBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balanceOfSafes[actorAddress];
        const prevTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
        const prevTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
        const prevProtocolMode = previousSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
        const prevActorEthBalance = previousSnapshot.accountSnapshot[actorAddress];
        const prevContractEthBalance = previousSnapshot.accountSnapshot[contractAddress];

        // --- 3. Calculate Expected Values ---
        const gasCost = BigInt(executionReceipt.gasUsed) * BigInt(executionReceipt.gasPrice);

        // Expected totalCollateral is: (initial totalCollateral + collateral accrued from _updateSafe) - collateral refunded
        const expectedNewTotalCollateral = prevTotalCollateral + collateralIncreaseFromUpdate - refundedCollateral;
        // Expected totalDebt is: initial totalDebt + debt accrued from _updateSafe
        const expectedNewTotalDebt = prevTotalDebt + debtIncreaseFromUpdate;

        const expectedActorEthBalance = prevActorEthBalance + refundedCollateral - gasCost;
        const expectedContractEthBalance = prevContractEthBalance - refundedCollateral;
        const expectedOwnerSafeBalance = prevOwnerBalance - 1n;

        let expectedProtocolMode = prevProtocolMode;
        if (prevProtocolMode === 0 /* BOOTSTRAP */ && (prevTotalDebt + debtIncreaseFromUpdate) > BOOTSTRAP_MODE_DEBT_THRESHOLD) {
            expectedProtocolMode = 1; /* NORMAL */
        }

        // --- 4. Assertions for newSnapshot State ---
        // safes mapping deletion
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId.toString()]).to.be.undefined;

        // ownerOf(safeId) and ERC721 burn
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safeOwner[safeId.toString()]).to.equal(ethers.ZeroAddress);

        // balanceOf(originalOwner)
        expect(newSnapshot.contractSnapshot.stableBaseCDP.balanceOfSafes[actorAddress]).to.equal(expectedOwnerSafeBalance);

        // _tokenApprovals[safeId] should be cleared to address(0)
        expect(newSnapshot.contractSnapshot.stableBaseCDP.safeApprovedAddress[safeId.toString()]).to.equal(ethers.ZeroAddress);

        // totalCollateral
        expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral).to.equal(finalTotalCollateral);
        expect(newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral).to.equal(expectedNewTotalCollateral); // Cross-check

        // totalDebt
        expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebt).to.equal(finalTotalDebt);
        expect(newSnapshot.contractSnapshot.stableBaseCDP.totalDebt).to.equal(expectedNewTotalDebt); // Cross-check

        // PROTOCOL_MODE
        expect(newSnapshot.contractSnapshot.stableBaseCDP.protocolMode).to.equal(expectedProtocolMode);

        // --- 5. Assertions for Balances ---
        expect(newSnapshot.accountSnapshot[actorAddress]).to.equal(expectedActorEthBalance);
        expect(newSnapshot.accountSnapshot[contractAddress]).to.equal(expectedContractEthBalance);

        // --- 6. Assertions for Events ---
        // SafeClosed event
        expect(safeClosedEvent!.args.safeId).to.equal(safeId);
        expect(safeClosedEvent!.args.refundedCollateral).to.equal(refundedCollateral);
        expect(safeClosedEvent!.args.totalCollateral).to.equal(finalTotalCollateral);
        expect(safeClosedEvent!.args.totalDebt).to.equal(finalTotalDebt);

        // RemovedSafe event
        expect(removedSafeEvent!.args.safeId).to.equal(safeId);
        // Validate the entire Safe struct data captured in RemovedSafe event
        expect(removedSafeEvent!.args.safe.collateralAmount).to.equal(safeStateAfterUpdate.collateralAmount);
        expect(removedSafeEvent!.args.safe.borrowedAmount).to.equal(safeStateAfterUpdate.borrowedAmount);
        expect(removedSafeEvent!.args.safe.weight).to.equal(safeStateAfterUpdate.weight);
        expect(removedSafeEvent!.args.safe.totalBorrowedAmount).to.equal(safeStateAfterUpdate.totalBorrowedAmount);
        expect(removedSafeEvent!.args.safe.feePaid).to.equal(safeStateAfterUpdate.feePaid);

        // ERC721 Transfer event for burning the Safe NFT
        expect(transferEvent!.args.from).to.equal(actorAddress);
        expect(transferEvent!.args.to).to.equal(ethers.ZeroAddress);
        expect(BigInt(transferEvent!.args.tokenId)).to.equal(safeId);

        // SafeUpdated event (conditional)
        if (safeUpdatedEvent) {
            // Validate SafeUpdated event arguments if it was emitted
            expect(safeUpdatedEvent.args.safeId).to.equal(safeId);
            expect(safeUpdatedEvent.args._safeCollateralAmount).to.equal(safeStateAfterUpdate.collateralAmount);
            expect(safeUpdatedEvent.args._safeBorrowedAmount).to.equal(safeStateAfterUpdate.borrowedAmount);
            expect(safeUpdatedEvent.args.collateralIncrease).to.equal(collateralIncreaseFromUpdate);
            expect(safeUpdatedEvent.args.debtIncrease).to.equal(debtIncreaseFromUpdate);
            expect(safeUpdatedEvent.args.totalCollateral).to.equal(finalTotalCollateral); // totalCollateral after _updateSafe, then adjusted by closeSafe
            expect(safeUpdatedEvent.args.totalDebt).to.equal(finalTotalDebt); // totalDebt after _updateSafe, then adjusted by closeSafe
        } else {
             // Ensure SafeUpdated event was NOT emitted if _updateSafe didn't trigger changes
            expect(safeUpdatedEvent, "SafeUpdated event should not be emitted if _updateSafe did not trigger changes").to.not.exist;
        }

        return true;
    }
}
