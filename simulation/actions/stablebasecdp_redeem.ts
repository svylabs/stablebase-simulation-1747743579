import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class RedeemAction extends Action {
    contract: ethers.Contract;
    redemptionId: string;

    constructor(contract: ethers.Contract) {
        super("RedeemAction");
        this.contract = contract;
        this.redemptionId = "";
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
        const accountAddress = actor.account.address;
        const sbdBalance = dfidTokenSnapshot.balances[accountAddress] || BigInt(0);
        const totalDebt = stableBaseCDPSnapshot.totalDebt;

        if (sbdBalance <= BigInt(0) || totalDebt <= BigInt(0)) {
            return [false, {}, {}];
        }

        // Redeem up to the total debt, but not more than the SBD balance
        const amount = BigInt(context.prng.next()) % Math.min(Number(sbdBalance), Number(totalDebt)) + BigInt(1);

        const nearestSpotInLiquidationQueue = BigInt(0);
        this.redemptionId = ethers.keccak256(ethers.toUtf8Bytes(accountAddress + amount.toString() + context.prng.next().toString()));

        const actionParams = {
            amount: amount,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue
        };

        const newIdentifiers = {
            redemptionId: this.redemptionId
        };
        return [true, actionParams, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const tx = await this.contract.connect(actor.account.value).redeem(
            actionParams.amount,
            actionParams.nearestSpotInLiquidationQueue
        );

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
        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const amount = actionParams.amount;
        const accountAddress = actor.account.address;
        const contractAddress = this.contract.target;

        let redeemedAmount = BigInt(0);
        let refundedAmount = BigInt(0);
        let collateralAmount = BigInt(0);

        // Extract event data to get the actual state changes
        if (executionReceipt.receipt && executionReceipt.receipt.logs) {
            for (const log of executionReceipt.receipt.logs) {
                try {
                    if (log.address === contractAddress) {
                        const parsedLog = this.contract.interface.parseLog(log);

                        if (parsedLog && parsedLog.name === "RedeemedBatch") {
                            redeemedAmount = BigInt(parsedLog.args.amount.toString());
                            collateralAmount = BigInt(parsedLog.args.collateralAmount.toString());
                        }
                    }
                } catch (error) {
                    console.error("Error parsing log:", error);
                }
            }
        }

        // Total Debt should decrease
        const expectedTotalDebt = previousStableBaseCDPSnapshot.totalDebt - (redeemedAmount - refundedAmount);
        expect(newStableBaseCDPSnapshot.totalDebt).to.equal(expectedTotalDebt, "Total debt should decrease");

        // Account SBD balance should decrease by amount.
        const previousAccountSBD = previousDFIDTokenSnapshot.balances[accountAddress] || BigInt(0);
        const newAccountSBD = newDFIDTokenSnapshot.balances[accountAddress] || BigInt(0);
        expect(newAccountSBD).to.equal(previousAccountSBD - amount, "Account SBD balance should decrease by amount");

        // Contract SBD balance should increase by amount
        const previousContractSBD = previousDFIDTokenSnapshot.balances[contractAddress] || BigInt(0);
        const newContractSBD = newDFIDTokenSnapshot.balances[contractAddress] || BigInt(0);
        expect(newContractSBD).to.equal(previousContractSBD + amount, "Contract SBD balance should increase by amount");

        // Total supply of SBD might decrease (if redeemedAmount > refundedAmount)
        const expectedTotalSupply = previousDFIDTokenSnapshot.totalSupply - (redeemedAmount - refundedAmount);
        expect(newDFIDTokenSnapshot.totalSupply).to.equal(expectedTotalSupply, "Total supply should decrease or remain the same");

        //Total Collateral should decrease
        const expectedTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral - collateralAmount; 
        expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(expectedTotalCollateral, "Total Collateral should decrease");

        return true;
    }
}
