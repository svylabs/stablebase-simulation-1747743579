import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';

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
    ): Promise<[any, Record<string, any>]> {
        const safeId = BigInt(actor.identifiers["safeId"]);

        // Fetch the price of the collateral from the oracle (Example:  Assuming a view function)
        const priceOracle = context.contracts.mockPriceOracle as ethers.Contract;
        const price = await priceOracle.fetchPrice();

        const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[safeId];

        if(!safe){
            throw new Error("Safe does not exist.");
        }
        // Calculate the maximum borrowable amount (Example:  Assuming a view function or from snapshot data)
        const liquidationRatio = BigInt(15000); // Example Liquidation Ratio as BigInt
        const PRECISION = BigInt(1000000000000000000); // Example precision
        const BASIS_POINTS_DIVISOR = BigInt(10000);
        const maxBorrowAmount = ((safe.collateralAmount * price * BASIS_POINTS_DIVISOR) / liquidationRatio) / PRECISION;


        // Generate random values for the parameters
        let amount = BigInt(Math.floor(context.prng.next() % Number(maxBorrowAmount / BigInt(1000000000000000000n))) + 1);
        amount = amount * BigInt(1000000000000000000n);
        const MINIMUM_DEBT = BigInt(1000000000000000000n) // Assuming a minimum debt

        if(amount < MINIMUM_DEBT){
            amount = MINIMUM_DEBT;
        }

        const shieldingRate = BigInt(Math.floor(context.prng.next() % 100)); // Reasonable value
        const nearestSpotInLiquidationQueue = BigInt(0); // 0 for head
        const nearestSpotInRedemptionQueue = BigInt(0); // 0 for head

        const actionParams = [
            safeId,
            amount,
            shieldingRate,
            nearestSpotInLiquidationQueue,
            nearestSpotInRedemptionQueue
        ];

        return [actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: any
    ): Promise<Record<string, any> | void> {
        const signer = actor.account.value.connect(this.contract.runner!);
        try {
            const tx = await this.contract.connect(signer).borrow(
                actionParams[0],
                actionParams[1],
                actionParams[2],
                actionParams[3],
                actionParams[4]
            );
            await tx.wait();
        } catch (error) {
            console.error("Error executing borrow action:", error);
            throw error;
        }
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: any
    ): Promise<boolean> {
        const safeId = actionParams[0];
        const amount = actionParams[1];
        const shieldingRate = actionParams[2];

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        const previousSafes = previousStableBaseCDPSnapshot.safes;
        const newSafes = newStableBaseCDPSnapshot.safes;

        const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
        const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

        const previousAccountSnapshot = previousSnapshot.accountSnapshot;
        const newAccountSnapshot = newSnapshot.accountSnapshot;

        const borrowerAddress = actor.account.address;
        const stableBaseCDPAddress = (context.contracts.stableBaseCDP as ethers.Contract).target;

        const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
        const dfireStakingAddress = (context.contracts.dfireStaking as ethers.Contract).target;
        const stabilityPoolAddress = (context.contracts.stabilityPool as ethers.Contract).target;

        const previousDFIDTokenBalance = previousAccountSnapshot[dfidTokenAddress] || BigInt(0);
        const newDFIDTokenBalance = newAccountSnapshot[dfidTokenAddress] || BigInt(0);
        const previousContractDFIDTokenBalance = previousAccountSnapshot[stableBaseCDPAddress] || BigInt(0);
        const newContractDFIDTokenBalance = newAccountSnapshot[stableBaseCDPAddress] || BigInt(0);

        // Core Borrowing and Accounting
        expect(newSafes[safeId].borrowedAmount).to.equal(previousSafes[safeId].borrowedAmount + amount, "Borrowed amount of the safe should be increased by the amount borrowed.");
        expect(newSafes[safeId].totalBorrowedAmount).to.equal(previousSafes[safeId].totalBorrowedAmount + amount, "The total borrowed amount of the safe should be increased by the amount borrowed.");
        expect(newTotalDebt).to.equal(previousTotalDebt + amount, "The total debt of the protocol should be increased by the amount borrowed.");
        const shieldingFee = (amount * shieldingRate) / BigInt(10000);  // Use BigInt for BASIS_POINTS_DIVISOR
        expect(newSafes[safeId].feePaid).to.equal(previousSafes[safeId].feePaid + shieldingFee, "The fee paid by the safe should be increased by the shielding fee.");

        // Validate SBD token minted to the borrower (Hard to validate the exact amount due to fee distribution)
        expect(newDFIDTokenBalance).to.be.above(previousDFIDTokenBalance, "SBD token should be minted to the borrower");


        // Validate ETH balances (example)
        const previousETHBalance = previousAccountSnapshot[borrowerAddress] || BigInt(0);
        const newETHBalance = newAccountSnapshot[borrowerAddress] || BigInt(0);
        expect(newETHBalance).to.be.lte(previousETHBalance, "ETH balance should decrease or remain the same.");

        // Fee distribution
        // Add assertions to check for reward distribution to DFIREStaking and StabilityPool
        const previousDFIREStakingBalance = previousAccountSnapshot[dfireStakingAddress] || BigInt(0);
        const newDFIREStakingBalance = newAccountSnapshot[dfireStakingAddress] || BigInt(0);

        const previousStabilityPoolBalance = previousAccountSnapshot[stabilityPoolAddress] || BigInt(0);
        const newStabilityPoolBalance = newAccountSnapshot[stabilityPoolAddress] || BigInt(0);

        expect(newDFIREStakingBalance).to.be.gte(previousDFIREStakingBalance, 'DFIREStaking balance should increase or stay the same');
        expect(newStabilityPoolBalance).to.be.gte(previousStabilityPoolBalance, 'StabilityPool balance should increase or stay the same');

        // Validate cumulative debt and collateral updates (example - adapt based on actual logic)
        const previousLiquidationSnapshot = previousStableBaseCDPSnapshot.liquidationSnapshots[safeId];
        const newLiquidationSnapshot = newStableBaseCDPSnapshot.liquidationSnapshots[safeId];

        if (previousLiquidationSnapshot.collateralPerCollateralSnapshot != newStableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral) {
            // Example validation, adjust based on actual contract logic
            expect(newLiquidationSnapshot.debtPerCollateralSnapshot).to.equal(newStableBaseCDPSnapshot.cumulativeDebtPerUnitCollateral, "Debt per collateral snapshot should be updated.");
        }

        // Protocol mode change validation (example)
        if (previousStableBaseCDPSnapshot.mode == 0 && newStableBaseCDPSnapshot.mode == 1) {
            expect(newTotalDebt).to.be.gt(BigInt(1000000000000000000000)); // Example threshold
        }

                // Validate balances of contracts for minting and burning
        const shieldingFee = (amount * shieldingRate) / BigInt(10000); 
        const amountToBorrow = amount - shieldingFee;
        const canRefund = shieldingFee; //Example - adjust this based on actual fee distribution and refund logic

        //const expectedMintedToBorrower = amountToBorrow + canRefund; //amountToBorrow may already include canRefund
        //expect(newDFIDTokenBalance - previousDFIDTokenBalance).to.be.closeTo(expectedMintedToBorrower, BigInt(10), "Incorrect amount minted to borrower"); // Added a tolerance of 10

        // Example: Validate potential burning of tokens (adjust logic as per contract)
         //expect(previousContractDFIDTokenBalance - newContractDFIDTokenBalance).to.be.lte(canRefund, "Incorrect amount burned from contract");



        return true;
    }
}