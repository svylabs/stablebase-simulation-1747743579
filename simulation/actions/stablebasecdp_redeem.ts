import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class RedeemAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("RedeemAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
        const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;

        const actorBalance = currentSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const contractBalance = dfidTokenSnapshot.balances[actor.account.address] || BigInt(0);

        if (contractBalance <= BigInt(0)) {
            return [false, {}, {}];
        }

        let amount = BigInt(Math.floor(context.prng.next() % Number(contractBalance) + 1));

        if (amount > contractBalance) {
            amount = contractBalance;
        }

        const nearestSpotInLiquidationQueue = BigInt(Math.floor(context.prng.next() % 100));

        const canExecute = amount > BigInt(0) && actorBalance > BigInt(0);

        const actionParams = {
            amount: amount,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue
        };

        return [canExecute, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const { amount, nearestSpotInLiquidationQueue } = actionParams;
        const tx = await this.contract.connect(actor.account.value).redeem(
            amount,
            nearestSpotInLiquidationQueue
        );
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any,
        executionReceipt: ExecutionReceipt
    ): Promise<boolean> {
        const { amount, nearestSpotInLiquidationQueue } = actionParams;
        const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;

        const previousDfidToken = previousSnapshot.contractSnapshot.dfidToken;
        const newDfidToken = newSnapshot.contractSnapshot.dfidToken;
        const previousStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;

        const previousTotalCollateral = previousStableBaseCDP.totalCollateral;
        const newTotalCollateral = newStableBaseCDP.totalCollateral;
        const previousTotalDebt = previousStableBaseCDP.totalDebt;
        const newTotalDebt = newStableBaseCDP.totalDebt;

        const previousActorBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newActorBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        const previousContractDfidBalance = previousDfidToken.balances[this.contract.target] || BigInt(0);
        const newContractDfidBalance = newDfidToken.balances[this.contract.target] || BigInt(0);
        const previousUserDfidBalance = previousDfidToken.balances[actor.account.address] || BigInt(0);
        const newUserDfidBalance = newDfidToken.balances[actor.account.address] || BigInt(0);

        //expect(newUserDfidBalance).to.be.lte(previousUserDfidBalance - amount, "User DFID balance should decrease by amount");

        //expect(newContractDfidBalance).to.be.gte(previousContractDfidBalance + amount, "Contract DFID balance should increase by amount");
        expect(newActorBalance, "New actor balance should be valid").to.be.lte(previousActorBalance);

        expect(newTotalCollateral, "Total collateral should decrease").to.be.lte(previousTotalCollateral);

        expect(newTotalDebt, "Total debt should decrease").to.be.lte(previousTotalDebt);

        return true;
    }
}
