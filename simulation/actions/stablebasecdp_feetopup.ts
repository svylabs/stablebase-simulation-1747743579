import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class FeeTopupAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("FeeTopupAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safes = stableBaseCDP.safes;
        const safeIds = Object.keys(safes)
            .map(Number)
            .filter(
                (safeId) =>
                    safes[safeId as number] !== undefined &&
                    safes[safeId as number].collateralAmount > BigInt(0) &&
                    safes[safeId as number].borrowedAmount > BigInt(0)
            );

        if (safeIds.length === 0) {
            console.log("No safes available for fee topup.");
            return [false, {}, {}];
        }

        const safeId = safeIds[context.prng.next() % safeIds.length];
        const safe = safes[safeId as number];

        // Generate `topupRate` greater than 0. A reasonable value can be between 1 and 1000, representing 0.01% to 10%.
        const maxTopupRate = BigInt(1000); // Represents 10%
        const topupRate = BigInt((context.prng.next() % Number(maxTopupRate)) + 1);

        // Generate `nearestSpotInRedemptionQueue`. Can be 0 if unknown. Using 0 for simplicity.
        const nearestSpotInRedemptionQueue = BigInt(0);

        const sbdTokenContract = context.contracts.dfidToken;
        const sbdBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        const fee = (topupRate * safe.borrowedAmount) / BigInt(10000); // BASIS_POINTS_DIVISOR is 10000

        if (sbdBalance < fee) {
            console.log(`Insufficient SBD balance (${sbdBalance}) to pay fee (${fee}).`);
            return [false, {}, {}];
        }

        const actionParams = {
            safeId: BigInt(safeId),
            topupRate: topupRate,
            nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
        };

        console.log(`Fee topup parameters: safeId=${safeId}, topupRate=${topupRate}, nearestSpot=${nearestSpotInRedemptionQueue}`);

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { safeId, topupRate, nearestSpotInRedemptionQueue } = actionParams;

        const tx = await this.contract
            .connect(actor.account.value)
            .feeTopup(safeId, topupRate, nearestSpotInRedemptionQueue);

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
        const { safeId, topupRate } = actionParams;

        const previousStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;
        const previousDFIDToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDToken = newSnapshot.contractSnapshot.dfidToken;
        const dfireStakingPrevious = previousSnapshot.contractSnapshot.dfireStaking
        const dfireStakingNew = newSnapshot.contractSnapshot.dfireStaking
        const stabilityPoolPrevious = previousSnapshot.contractSnapshot.stabilityPool
        const stabilityPoolNew = newSnapshot.contractSnapshot.stabilityPool

        const previousSafe = previousStableBaseCDP.safes[safeId as number];
        const newSafe = newStableBaseCDP.safes[safeId as number];

        // Validate that `safes[safeId].weight` is increased by `topupRate` compared to its previous value.
        expect(newSafe.weight).to.equal(previousSafe.weight + topupRate, "Weight should increase by topupRate");

        // Calculate fee paid by the user
        const fee = (topupRate * previousSafe.borrowedAmount) / BigInt(10000);

        // Validate that `safes[safeId].feePaid` is increased by the calculated `fee` amount.
        expect(newSafe.feePaid).to.equal(previousSafe.feePaid + fee, "feePaid should increase by fee");

        // Validate sbdToken balance changes.
        const previousSBDTokenBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newSBDTokenBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const previousContractSBDTokenBalance = previousSnapshot.accountSnapshot[this.contract.target] || BigInt(0);
        const newContractSBDTokenBalance = newSnapshot.accountSnapshot[this.contract.target] || BigInt(0);

        let refundFee = BigInt(0);

        const transferEvents = executionReceipt.receipt?.logs.filter((log: any) => {
            try {
                const parsedLog = new ethers.Interface(JSON.stringify(context.contracts.dfidToken.interface.fragments)).parseLog(log);
                return parsedLog.name === 'Transfer';
            } catch (e) {
                return false;
            }
        }) || [];

        const refundEvent = transferEvents.find(event => {
            try {
                const parsedLog = new ethers.Interface(JSON.stringify(context.contracts.dfidToken.interface.fragments)).parseLog(event);
                // Check if the transfer is to the actor's account
                return parsedLog.args.to === actor.account.address;
            } catch (e) {
                return false;
            }
        });

        if (refundEvent) {
            try {
                const parsedLog = new ethers.Interface(JSON.stringify(context.contracts.dfidToken.interface.fragments)).parseLog(refundEvent);
                refundFee = parsedLog.args.value;
            } catch (e) {
                console.error("Error parsing refund event:", e);
            }
        }

        expect(newSBDTokenBalance).to.equal(previousSBDTokenBalance - fee + refundFee, "SBD Token balance of user should decrease by fee and increase by refundFee.");
        expect(newContractSBDTokenBalance).to.equal(previousContractSBDTokenBalance + fee - refundFee, "SBD Token balance of contract should increase by fee and decrease by refundFee");

        // Validate events
        let feeTopupEventFound = false;
        let redemptionQueueUpdatedEventFound = false;
        let safeUpdatedEventFound = false;
        let feeDistributedEventFound = false;

        executionReceipt.receipt?.logs.forEach((log: any) => {
            try {
                const parsedLog = this.contract.interface.parseLog(log);

                if (parsedLog.name === 'FeeTopup') {
                    feeTopupEventFound = true;
                }
                if (parsedLog.name === 'RedemptionQueueUpdated') {
                    redemptionQueueUpdatedEventFound = true;
                }
                if (parsedLog.name === 'SafeUpdated') {
                    safeUpdatedEventFound = true;
                }
                if (parsedLog.name === 'FeeDistributed') {
                    feeDistributedEventFound = true;
                }
            } catch (e) { }
        });

        expect(feeTopupEventFound, 'FeeTopup event should be emitted').to.be.true;
        expect(redemptionQueueUpdatedEventFound, 'RedemptionQueueUpdated event should be emitted').to.be.true;
        expect(safeUpdatedEventFound, 'SafeUpdated event should be emitted').to.be.true;
        expect(feeDistributedEventFound, 'FeeDistributed event should be emitted').to.be.true;


        //Fee distribution validation
        const feeDistributedEvent = executionReceipt.receipt?.logs.find((log: any) => {
            try {
                const parsedLog = this.contract.interface.parseLog(log);
                return parsedLog.name === 'FeeDistributed';
            } catch (e) {
                return false;
            }
        });

        let sbrStakersFee:BigInt = BigInt(0);
        let stabilityPoolFee:BigInt = BigInt(0);
        if(feeDistributedEvent) {
            try {
                const parsedLog = this.contract.interface.parseLog(feeDistributedEvent);
                sbrStakersFee = parsedLog.args.sbrStakersFee
                stabilityPoolFee = parsedLog.args.stabilityPoolFee
            } catch (e) {
                console.error("Error parsing feeDistributed event:", e);
            }
        }
        if (sbrStakersFee > BigInt(0)) {
            expect(dfireStakingNew.totalRewardPerToken).to.greaterThan(dfireStakingPrevious.totalRewardPerToken)
        }
        if (stabilityPoolFee > BigInt(0)) {
            expect(stabilityPoolNew.totalRewardPerToken).to.greaterThan(stabilityPoolPrevious.totalRewardPerToken)
        }

        // TODO: Add more validations based on the action summary, especially totalDebt and totalCollateral changes.

        return true;
    }
}
