import { Actor, RunContext, Snapshot, Action } from '@svylabs/ilumia';
import { ethers } from 'ethers';
import { expect } from 'chai';

export class BorrowAction extends Action {
    private contract: ethers.Contract;

    constructor(contract: ethers.Contract) {
        super('BorrowAction');
        this.contract = contract;
    }

    async initialize(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot
    ): Promise<[[bigint, bigint, bigint, bigint, bigint], Record<string, any>]> {
        const safeId = actor.getIdentifiers().safeId as bigint; // Assuming safeId is stored as an identifier

        const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
        const safe = stableBaseCDPSnapshot.safes[safeId];

        if (!safe) {
            throw new Error(`Safe with ID ${safeId} not found.`);
        }

        // Generate a random amount to borrow, ensuring it meets the criteria
        const minBorrowAmount = BigInt(100); // Example: Minimum debt

        const maxBorrowAmount = ((safe.collateralAmount * currentSnapshot.contractSnapshot.mockPriceOracle.currentPrice * stableBaseCDPSnapshot.cumulativeCollateralPerUnitCollateral) / BigInt(110)) / BigInt(10**18) ;

        let amount = BigInt(context.prng.next()) % (maxBorrowAmount - safe.borrowedAmount);  // Random amount less than max
        amount = amount > minBorrowAmount ? amount : minBorrowAmount ;

        if (amount + safe.borrowedAmount < BigInt(100)) {
            amount = BigInt(100) - safe.borrowedAmount;
        }

        // Generate a shielding rate.  Keep it under 1000 basis points
        const shieldingRate = BigInt(context.prng.next()) % BigInt(1000);

        // Use zero for nearestSpot hints
        const nearestSpotInLiquidationQueue = BigInt(0);
        const nearestSpotInRedemptionQueue = BigInt(0);

        const actionParams: [bigint, bigint, bigint, bigint, bigint] = [
            safeId,
            amount,
            shieldingRate,
            nearestSpotInLiquidationQueue,
            nearestSpotInRedemptionQueue,
        ];

        return [actionParams, {}];
    }

    async execute(
        context: RunContext,
        actor: Actor,
        currentSnapshot: Snapshot,
        actionParams: [bigint, bigint, bigint, bigint, bigint]
    ): Promise<Record<string, any> | void> {
        const [safeId, amount, shieldingRate, nearestSpotInLiquidationQueue, nearestSpotInRedemptionQueue] = actionParams;

        const tx = await this.contract
            .connect(actor.account.value)
            .borrow(
                safeId,
                amount,
                shieldingRate,
                nearestSpotInLiquidationQueue,
                nearestSpotInRedemptionQueue
            );
        await tx.wait();
    }

    async validate(
        context: RunContext,
        actor: Actor,
        previousSnapshot: Snapshot,
        newSnapshot: Snapshot,
        actionParams: [bigint, bigint, bigint, bigint, bigint]
    ): Promise<boolean> {
        const [safeId, amount, shieldingRate, ,] = actionParams;

        const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
        const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

        const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
        const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;

        const previousSafe = previousStableBaseCDPSnapshot.safes[safeId];
        const newSafe = newStableBaseCDPSnapshot.safes[safeId];

        // Core Validation
        expect(newSafe.borrowedAmount).to.equal(previousSafe.borrowedAmount + amount, 'safe.borrowedAmount should increase by amount');
        expect(newSafe.totalBorrowedAmount).to.equal(previousSafe.totalBorrowedAmount + amount, 'safe.totalBorrowedAmount should increase by amount');
        expect(newStableBaseCDPSnapshot.totalDebt).to.equal(previousStableBaseCDPSnapshot.totalDebt + amount, 'totalDebt should increase by amount');

        const _shieldingFee = (amount * shieldingRate) / BigInt(10000);
        const _amountToBorrow = amount - _shieldingFee;

        const deltaSBD = newDFIDTokenSnapshot.totalTokenSupply - previousDFIDTokenSnapshot.totalTokenSupply; //Total SBD Minted or Burned

        const balanceChange = (newSnapshot.accountSnapshot[context.contracts.dfidToken.target] || BigInt(0)) - (previousSnapshot.accountSnapshot[context.contracts.dfidToken.target] || BigInt(0)); //Token balances for the DFIDToken
        expect(deltaSBD).to.equal(_amountToBorrow, 'DFIDToken Supply must have increased by the amount to borrow');
        expect(balanceChange).to.equal(_amountToBorrow, 'The borrower (msg.sender) SBD balance should reflect the borrowed amount');

        expect(newSafe.feePaid).to.equal(previousSafe.feePaid + _shieldingFee, 'safe.feePaid should increase by _shieldingFee');

        // Add more validation rules based on the provided action summary

        const previousDFIREStakingSnapshot = previousSnapshot.contractSnapshot.dfireStaking; // Assuming DFIDToken is SBD
        const newDFIREStakingSnapshot = newSnapshot.contractSnapshot.dfireStaking;

        const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool; // Assuming DFIDToken is SBD
        const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

        if (previousDFIREStakingSnapshot && newDFIREStakingSnapshot) {
          //Validate DFIREStaking
          const feeDistributed = newDFIREStakingSnapshot.totalRewardPerToken - previousDFIREStakingSnapshot.totalRewardPerToken;  //DFIRE staking rewards
        }

        if (previousStabilityPoolSnapshot && newStabilityPoolSnapshot) {
            //Validate StabilityPool
            const feeDistributed = newStabilityPoolSnapshot.totalRewardPerToken- previousStabilityPoolSnapshot.totalRewardPerToken;  //Stability Pool staking rewards
        }

        return true;
    }
}
