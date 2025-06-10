import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class BorrowAction extends Action {
    contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("BorrowAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safeId = actor.identifiers["safeId"] || BigInt(context.prng.next() % 100) + BigInt(1);

        // Check if safe exists and has collateral
        if (!stableBaseCDPSnapshot.safeInfo) {
          console.warn("Safe does not exist, cannot borrow.");
          return [false, {}, {}];
        }

        // Fetch necessary values from snapshot
        const collateralAmount = stableBaseCDPSnapshot.safeInfo.collateralAmount || BigInt(0);
        const borrowedAmount = stableBaseCDPSnapshot.safeInfo.borrowedAmount || BigInt(0);
        const liquidationRatio = BigInt(15000); // Assuming 150% liquidation ratio. This value needs to come from snapshot if available
        const price = BigInt(1000); // Assuming price is 1000, needs to come from priceOracle snapshot
        const minimumDebt = BigInt(100); // This should come from the contract/snapshot if possible

        // Calculate maxBorrowAmount based on collateral, price, and liquidation ratio
        const maxBorrowAmount = (collateralAmount * price * BigInt(10000)) / liquidationRatio / BigInt(1000000000); //PRECISION is 10**9
        
        // Generate random amount within valid range
        let amount = BigInt(context.prng.next() % Number(maxBorrowAmount - borrowedAmount));
        if(amount < minimumDebt) {
            amount = minimumDebt;
        }
        if(amount > (maxBorrowAmount - borrowedAmount)){
            amount = maxBorrowAmount - borrowedAmount;
        }
        const shieldingRate = BigInt(context.prng.next() % 100); // Example shielding rate (0-99)
        const nearestSpotInLiquidationQueue = BigInt(0);
        const nearestSpotInRedemptionQueue = BigInt(0);

        const actionParams = {
            safeId: safeId,
            amount: amount,
            shieldingRate: shieldingRate,
            nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
            nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue
        };

        return [true, actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        try {
            const tx = await this.contract.connect(actor.account.value).borrow(
                actionParams.safeId,
                actionParams.amount,
                actionParams.shieldingRate,
                actionParams.nearestSpotInLiquidationQueue,
                actionParams.nearestSpotInRedemptionQueue,
                {
                    gasLimit: 1000000 // Adjust gas limit as needed
                }
            );
            const receipt = await tx.wait();
            return {
                receipt: receipt
            };
        } catch (error) {
            console.error("Transaction failed:", error);
            throw error; // Re-throw the error to be caught by the framework
        }
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
        const dfidTokenAddress = (context.contracts.dfidToken as any).target;
        const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
        const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);

        const safeId = actionParams.safeId;
        const amount = actionParams.amount;
        const shieldingRate = actionParams.shieldingRate;

        // State Validation
        expect(newStableBaseCDPSnapshot.safeInfo.borrowedAmount).to.equal(previousStableBaseCDPSnapshot.safeInfo.borrowedAmount + amount, "borrowedAmount should be increased by the amount borrowed.");
        expect(newStableBaseCDPSnapshot.safeInfo.totalBorrowedAmount).to.equal(previousStableBaseCDPSnapshot.safeInfo.totalBorrowedAmount + amount, "totalBorrowedAmount should be increased by the amount borrowed.");

        const shieldingFee = (amount * shieldingRate) / BigInt(10000);
        expect(newStableBaseCDPSnapshot.safeInfo.feePaid).to.equal(previousStableBaseCDPSnapshot.safeInfo.feePaid + shieldingFee, "feePaid should be increased by the shielding fee.");

        // Account balance validation - Checking ETH balance decrease
        expect(newAccountBalance).to.lte(previousAccountBalance - BigInt(executionReceipt.receipt.gasUsed * executionReceipt.receipt.effectiveGasPrice), "Account balance should decrease after borrowing");

        //Token Balance Validation
        const previousDFIDTokenBalance = previousSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);
        const newDFIDTokenBalance = newSnapshot.accountSnapshot[dfidTokenAddress] || BigInt(0);
        const amountToBorrow = amount - shieldingFee;

        //Validation for token balance
        expect(newDFIDTokenBalance).to.equal(previousDFIDTokenBalance + amountToBorrow, "Borrower should have received _amountToBorrow SBD tokens.");

        expect(newStableBaseCDPSnapshot.totalDebt).to.equal(previousStableBaseCDPSnapshot.totalDebt + amount, "totalDebt should be increased by amount.");

        //Event Validation - to be implemented.

        return true;
    }
}