import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

class OpenSafeAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super("OpenSafeAction");
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[boolean, any, Record<string, any>]> {
        const actorAddress = actor.account.address;
        const actorEthBalance = currentSnapshot.accountSnapshot[actorAddress] || 0n;

        // Rule: The '_safeId' (uint256) parameter must be a unique, positive integer that is not currently associated with an existing Safe or NFT within the contract.
        let safeId: bigint;
        const existingSafeDetails = new Set(Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safeDetails).map(BigInt));
        const existingSafeOwners = new Set(Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safeOwner).map(BigInt));

        const MAX_SAFE_ID_ATTEMPTS = 100; // Limit attempts to find a unique ID
        let foundUniqueSafeId = false;
        for (let i = 0; i < MAX_SAFE_ID_ATTEMPTS; i++) {
            // Generate a random positive BigInt for safeId, ensuring it's not 0
            safeId = BigInt(context.prng.next()) + (BigInt(context.prng.next()) << 32n) + 1n; 
            
            // Check if safeId is unique based on existing safes and NFT owners
            if (!existingSafeDetails.has(safeId) && !existingSafeOwners.has(safeId)) {
                foundUniqueSafeId = true;
                break;
            }
        }

        if (!foundUniqueSafeId) {
            console.warn("Could not find a unique safeId after multiple attempts. Skipping OpenSafe action.");
            return [false, {}, {}];
        }

        // Rule: The '_amount' (uint256) parameter must be a positive integer.
        // Rule: The transaction's 'msg.value' (the amount of Ether sent with the transaction) must be exactly equal to the '_amount' parameter.
        const GAS_BUFFER = ethers.parseEther("0.1"); // A reasonable buffer for gas
        let maxAmount = actorEthBalance - GAS_BUFFER;
        
        if (maxAmount <= 0n) {
            console.warn("Actor has insufficient ETH balance to open a safe with a positive amount, after accounting for gas buffer.");
            return [false, {}, {}];
        }

        // Generate a random amount between 1 and maxAmount
        let amount = BigInt(context.prng.next()) % maxAmount; 
        if (amount < 1n) { 
            amount = 1n;
        }

        // Final check for sufficient balance for the chosen amount plus gas buffer
        if (actorEthBalance < amount + GAS_BUFFER) {
            console.warn(`Actor ETH balance (${actorEthBalance}) is not sufficient for proposed amount (${amount}) + gas buffer (${GAS_BUFFER}).`);
            return [false, {}, {}];
        }

        const actionParams = {
            _safeId: safeId,
            _amount: amount,
        };

        const newIdentifiers = {
            safeId: safeId.toString(), // Store as string for identifier tracking
        };

        return [true, actionParams, newIdentifiers];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<ExecutionReceipt> {
        const { _safeId, _amount } = actionParams;
        const signer = actor.account.value as ethers.Signer;

        // Call openSafe function, sending _amount as msg.value
        const txResponse = await this.contract.connect(signer).openSafe(_safeId, _amount, { value: _amount });
        const receipt = await txResponse.wait();
        if (!receipt) {
            throw new Error("Transaction failed or did not get a receipt.");
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
        const { _safeId, _amount } = actionParams;
        const actorAddress = actor.account.address;
        const contractAddress = this.contract.target as string;

        // 1. Validate contract state updates
        const prevStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;

        // 1a. Safe Data Initialization (safes[_safeId])
        expect(newStableBaseCDP.safeDetails[_safeId.toString()]?.collateralAmount, "collateralAmount should match _amount").to.equal(_amount);
        expect(newStableBaseCDP.safeDetails[_safeId.toString()]?.borrowedAmount, "borrowedAmount should be 0").to.equal(0n);
        expect(newStableBaseCDP.safeDetails[_safeId.toString()]?.weight, "weight should be 0").to.equal(0n);
        expect(newStableBaseCDP.safeDetails[_safeId.toString()]?.totalBorrowedAmount, "totalBorrowedAmount should be 0").to.equal(0n);
        expect(newStableBaseCDP.safeDetails[_safeId.toString()]?.feePaid, "feePaid should be 0").to.equal(0n);

        // 1b. Liquidation Snapshot Initialization (liquidationSnapshots[_safeId])
        // Based on the snapshot structure, `inactiveDebtAndCollateral` is assumed to represent `liquidationSnapshots`.
        const prevCumulativeDebtPerUnitCollateral = prevStableBaseCDP.cumulativeDebtPerUnitCollateral;
        const prevCumulativeCollateralPerUnitCollateral = prevStableBaseCDP.cumulativeCollateralPerUnitCollateral;

        expect(newStableBaseCDP.inactiveDebtAndCollateral[_safeId.toString()]?.inactiveDebt, "debtPerCollateralSnapshot should match previous cumulativeDebtPerUnitCollateral").to.equal(prevCumulativeDebtPerUnitCollateral);
        expect(newStableBaseCDP.inactiveDebtAndCollateral[_safeId.toString()]?.inactiveCollateral, "collateralPerCollateralSnapshot should match previous cumulativeCollateralPerUnitCollateral").to.equal(prevCumulativeCollateralPerUnitCollateral);

        // 1c. Protocol-wide Collateral Tracking (totalCollateral)
        const expectedTotalCollateral = prevStableBaseCDP.totalCollateral + _amount;
        expect(newStableBaseCDP.totalCollateral, "totalCollateral should increase by _amount").to.equal(expectedTotalCollateral);

        // 1d. NFT Ownership Transfer (_owners and _balances)
        expect(newStableBaseCDP.safeOwner[_safeId.toString()], "NFT owner should be actor address").to.equal(actorAddress);
        
        const prevActorNftBalance = previousSnapshot.contractSnapshot.stableBaseCDP.balanceOfSafes[actorAddress] || 0n;
        const newActorNftBalance = newSnapshot.contractSnapshot.stableBaseCDP.balanceOfSafes[actorAddress] || 0n;
        expect(newActorNftBalance, "Actor's NFT balance should increase by 1").to.equal(prevActorNftBalance + 1n);


        // 2. Validate ETH balance changes
        const gasUsed = BigInt(executionReceipt.gasUsed.toString());
        const gasPrice = BigInt(executionReceipt.gasPrice.toString());
        const totalGasCost = gasUsed * gasPrice;

        const prevActorEthBalance = previousSnapshot.accountSnapshot[actorAddress] || 0n;
        const newActorEthBalance = newSnapshot.accountSnapshot[actorAddress] || 0n;
        
        // Expected ETH balance = previous balance - _amount (msg.value) - gas cost
        const expectedActorEthBalance = prevActorEthBalance - _amount - totalGasCost;
        expect(newActorEthBalance, "Actor ETH balance should reflect amount sent and gas cost").to.equal(expectedActorEthBalance);

        // 3. Validate events
        let openSafeEventFound = false;
        let transferEventFound = false;

        for (const log of executionReceipt.logs) {
            try {
                // Try parsing with contract's interface
                const parsedLog = this.contract.interface.parseLog(log);
                if (parsedLog) {
                    if (parsedLog.name === "OpenSafe") {
                        openSafeEventFound = true;
                        expect(parsedLog.args.safeId, "OpenSafe event safeId mismatch").to.equal(_safeId);
                        expect(parsedLog.args.owner, "OpenSafe event owner mismatch").to.equal(actorAddress);
                        expect(parsedLog.args.amount, "OpenSafe event amount mismatch").to.equal(_amount);
                        expect(parsedLog.args.totalCollateral, "OpenSafe event totalCollateral mismatch").to.equal(newStableBaseCDP.totalCollateral);
                        expect(parsedLog.args.totalDebt, "OpenSafe event totalDebt mismatch").to.equal(newStableBaseCDP.totalDebt); // totalDebt should be unchanged by this operation
                    } else if (parsedLog.name === "Transfer") {
                        // ERC721 Transfer event
                        transferEventFound = true;
                        expect(parsedLog.args.from, "Transfer event from mismatch").to.equal(ethers.ZeroAddress);
                        expect(parsedLog.args.to, "Transfer event to mismatch").to.equal(actorAddress);
                        expect(parsedLog.args.tokenId, "Transfer event tokenId mismatch").to.equal(_safeId);
                    }
                }
            } catch (e) {
                // Log was not from this contract's interface or was not a known event, ignore
            }
        }

        expect(openSafeEventFound, "OpenSafe event not emitted").to.be.true;
        expect(transferEventFound, "Transfer event not emitted").to.be.true;

        return true;
    }
}
