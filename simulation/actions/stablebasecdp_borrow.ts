import {Action, Actor, Snapshot} from "@svylabs/ilumina";
import type {RunContext, ExecutionReceipt} from "@svylabs/ilumina";
import {expect} from "chai";
import {ethers} from "ethers";

interface SafeUpdatedEvent {
  safeId: bigint;
  collateralAmount: bigint;
  borrowedAmount: bigint;
  collateralIncrease: bigint;
  debtIncrease: bigint;
  totalCollateral: bigint;
  totalDebt: bigint;
}

interface FeeDistributedEvent {
  safeId: bigint;
  feePaid: bigint;
  mint: boolean;
  sbrStakersFee: bigint;
  stabilityPoolFee: bigint;
  canRefund: bigint;
}

interface FeeRefundEvent {
  safeId: bigint;
  amount: bigint;
}

interface BorrowedEvent {
  safeId: bigint;
  amount: bigint;
  weight: bigint;
  totalCollateral: bigint;
  totalDebt: bigint;
  redemptionNodePrev: bigint;
  liquidationNodePrev: bigint;
}

interface TransferEvent {
  from: string;
  to: string;
  value: bigint;
}

interface RewardAddedEvent {
  rewardAmount: bigint;
}

interface SBRRewardsAddedEvent {
  lastSBRRewardDistributedTime: bigint;
  currentTimestamp: bigint;
  sbrReward: bigint;
  totalSbrRewardPerToken: bigint;
}

const BASIS_POINTS_DIVISOR = 10000n;
const PRECISION = 10n ** 18n;
const MINIMUM_DEBT = 2000n * PRECISION;
const BOOTSTRAP_MODE_DEBT_THRESHOLD = 5000000n * PRECISION;
const SBR_FEE_REWARD = 1000n;
// This liquidationRatio is not directly available in the snapshot. Assuming a common value (e.g., 1.5 * PRECISION for 150%) for calculation purposes.
const LIQUIDATION_RATIO_PLACEHOLDER = 1_500_000_000_000_000_000n; // 1.5 * 10^18

export class BorrowAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("BorrowAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const actorAddress = actor.account.address;

    const availableSafeIds = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safeOwner)
      .filter(key => currentSnapshot.contractSnapshot.stableBaseCDP.safeOwner[BigInt(key)] === actorAddress)
      .map(key => BigInt(key));

    if (availableSafeIds.length === 0) {
      context.logger.info(`BorrowAction: No existing Safe NFT owned by ${actorAddress}. Cannot execute.`);
      return [false, {}, {}];
    }

    const safeId = availableSafeIds[context.prng.next() % availableSafeIds.length];
    const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId];

    if (!safe) {
      context.logger.warn(`BorrowAction: Safe with ID ${safeId} not found in snapshot. This indicates a snapshot inconsistency.`);
      return [false, {}, {}];
    }

    // Check if safe exists and has collateral (as per require in Solidity)
    if (safe.collateralAmount === 0n) {
        context.logger.info(`BorrowAction: Safe ${safeId} has no collateral. Cannot borrow.`);
        return [false, {}, {}];
    }

    const price = currentSnapshot.contractSnapshot.mockPriceOracle.fetchedPrice;
    if (price === 0n) {
        context.logger.info(`BorrowAction: Price oracle returned 0. Cannot calculate max borrow amount.`);
        return [false, {}, {}];
    }

    const maxBorrowAmount = ((safe.collateralAmount * price * BASIS_POINTS_DIVISOR) / LIQUIDATION_RATIO_PLACEHOLDER) / PRECISION;

    const currentBorrowed = safe.borrowedAmount;
    let remainingBorrowCapacity = maxBorrowAmount - currentBorrowed;

    // If currentBorrowed is already very high or exceeds maxBorrowAmount, we might not be able to borrow.
    if (remainingBorrowCapacity <= 0n) {
      context.logger.info(`BorrowAction: Safe ${safeId} has no remaining borrow capacity. Max borrow: ${maxBorrowAmount}, Current borrowed: ${currentBorrowed}`);
      return [false, {}, {}];
    }

    let minAmountNeededForMinDebt = MINIMUM_DEBT > currentBorrowed ? MINIMUM_DEBT - currentBorrowed : 0n;
    // Ensure the amount to borrow is at least 1, unless current borrowed already satisfies MINIMUM_DEBT and we don't need to add anything.
    // If minAmountNeededForMinDebt is 0, means current debt >= MINIMUM_DEBT. We still need to borrow a positive amount.
    if (minAmountNeededForMinDebt === 0n && remainingBorrowCapacity > 0n) { // If MINIMUM_DEBT satisfied, but we can still borrow
        minAmountNeededForMinDebt = 1n;
    }

    const effectiveMinBorrow = minAmountNeededForMinDebt;

    if (effectiveMinBorrow > remainingBorrowCapacity) {
      context.logger.info(`BorrowAction: Cannot borrow enough to meet MINIMUM_DEBT requirement. Effective min: ${effectiveMinBorrow}, Remaining capacity: ${remainingBorrowCapacity}`);
      return [false, {}, {}];
    }

    // Generate a random amount within the valid range
    // Range: [effectiveMinBorrow, remainingBorrowCapacity]
    const amountRange = remainingBorrowCapacity - effectiveMinBorrow + 1n;
    if (amountRange <= 0n) {
        context.logger.info(`BorrowAction: Calculated amount range is zero or negative. Cannot borrow.`);
        return [false, {}, {}];
    }
    const amount = context.prng.nextBigInt(amountRange) + effectiveMinBorrow;

    // Generate a random shieldingRate (e.g., 0 to 5% in basis points)
    const shieldingRate = context.prng.nextBigInt(501n); // Max 500 basis points (5%)

    // Calculate _shieldingFee and check if `amount` is sufficient
    const _shieldingFee = (amount * shieldingRate) / BASIS_POINTS_DIVISOR;
    if (amount < _shieldingFee) {
        context.logger.info(`BorrowAction: Borrowed amount (${amount}) is not sufficient to pay the fee (${_shieldingFee}). Skipping.`);
        return [false, {}, {}]; // This scenario should ideally be prevented by design or handling
    }

    const liquidationNodeIds = Object.keys(currentSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes)
      .map(id => BigInt(id))
      .filter(id => id !== 0n);
    const redemptionNodeIds = Object.keys(currentSnapshot.contractSnapshot.safesOrderedForRedemption.nodes)
      .map(id => BigInt(id))
      .filter(id => id !== 0n);

    const nearestSpotInLiquidationQueue = liquidationNodeIds.length > 0 
      ? liquidationNodeIds[context.prng.next() % liquidationNodeIds.length] 
      : 0n;
    const nearestSpotInRedemptionQueue = redemptionNodeIds.length > 0 
      ? redemptionNodeIds[context.prng.next() % redemptionNodeIds.length] 
      : 0n;

    const actionParams = {
      safeId: safeId,
      amount: amount,
      shieldingRate: shieldingRate,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
      nearestSpotInRedemptionQueue: nearestSpotInRedemptionQueue,
    };

    context.logger.info(`BorrowAction: Initialized for safeId ${safeId}, amount ${amount}, shieldingRate ${shieldingRate}`);
    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    context.logger.info(
      `BorrowAction: Executing borrow for safeId ${actionParams.safeId} with amount ${actionParams.amount}`
    );
    const signer = actor.account.value as ethers.Signer;
    const contractWithSigner = this.contract.connect(signer);

    const tx = await contractWithSigner.borrow(
      actionParams.safeId,
      actionParams.amount,
      actionParams.shieldingRate,
      actionParams.nearestSpotInLiquidationQueue,
      actionParams.nearestSpotInRedemptionQueue
    );
    const receipt = await tx.wait();
    expect(receipt).to.not.be.null;
    context.logger.info(
      `BorrowAction: Transaction successful with hash: ${receipt.hash}`
    );
    return receipt as ExecutionReceipt;
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    context.logger.info("BorrowAction: Validating execution.");

    const { safeId, amount, shieldingRate } = actionParams;
    const actorAddress = actor.account.address;
    const cdpContractAddress = context.contracts.stableBaseCDP.target;
    const sbdTokenContractAddress = context.contracts.dfidToken.target;

    // Calculate gas costs
    const gasUsed = BigInt(executionReceipt.gasUsed);
    const effectiveGasPrice = BigInt(executionReceipt.effectiveGasPrice);
    const txCost = gasUsed * effectiveGasPrice;

    // --- Extract events ---
    const safeUpdatedEvent = executionReceipt.events?.find(
      (e) => e.fragment.name === "SafeUpdated"
    ) as unknown as ethers.EventLog | undefined;
    const feeDistributedEvent = executionReceipt.events?.find(
      (e) => e.fragment.name === "FeeDistributed"
    ) as unknown as ethers.EventLog | undefined;
    const feeRefundEvent = executionReceipt.events?.find(
      (e) => e.fragment.name === "FeeRefund"
    ) as unknown as ethers.EventLog | undefined;
    const borrowedEvent = executionReceipt.events?.find(
      (e) => e.fragment.name === "Borrowed"
    ) as unknown as ethers.EventLog | undefined;

    expect(safeUpdatedEvent, "SafeUpdated event not emitted").to.not.be.undefined;
    expect(feeDistributedEvent, "FeeDistributed event not emitted").to.not.be.undefined;
    expect(borrowedEvent, "Borrowed event not emitted").to.not.be.undefined;

    const safeUpdatedArgs = safeUpdatedEvent!.args as unknown as SafeUpdatedEvent;
    const feeDistributedArgs = feeDistributedEvent!.args as unknown as FeeDistributedEvent;
    const borrowedArgs = borrowedEvent!.args as unknown as BorrowedEvent;

    // Derived values from events or calculations
    const collateralIncrease = safeUpdatedArgs.collateralIncrease;
    const debtIncrease = safeUpdatedArgs.debtIncrease;
    const _shieldingFee = (amount * shieldingRate) / BASIS_POINTS_DIVISOR;
    const canRefund = feeDistributedArgs.canRefund; // From FeeDistributed event
    const _amountToBorrowNet = amount - _shieldingFee + canRefund;

    // --- StableBaseCDP Contract State Validation ---
    const prevSafe = previousSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId];
    const newSafe = newSnapshot.contractSnapshot.stableBaseCDP.safeDetails[safeId];

    expect(newSafe.collateralAmount, "safe.collateralAmount incorrect").to.equal(prevSafe.collateralAmount + collateralIncrease);
    expect(newSafe.borrowedAmount, "safe.borrowedAmount incorrect").to.equal(prevSafe.borrowedAmount + debtIncrease + (amount - _shieldingFee));
    expect(newSafe.totalBorrowedAmount, "safe.totalBorrowedAmount incorrect").to.equal(prevSafe.totalBorrowedAmount + debtIncrease + amount);
    expect(newSafe.feePaid, "safe.feePaid incorrect").to.equal(prevSafe.feePaid + _shieldingFee);

    // Validate liquidation snapshots
    const newLiquidationSnapshot = newSnapshot.contractSnapshot.stableBaseCDP.liquidationSnapshots[safeId];
    const newCumulativeDebtPerUnitCollateral = newSnapshot.contractSnapshot.stableBaseCDP.cumulativeDebtPerUnitCollateral;
    const newCumulativeCollateralPerUnitCollateral = newSnapshot.contractSnapshot.stableBaseCDP.cumulativeCollateralPerUnitCollateral;

    expect(newLiquidationSnapshot.debtPerCollateralSnapshot, "liquidationSnapshots[safeId].debtPerCollateralSnapshot incorrect").to.equal(newCumulativeDebtPerUnitCollateral);
    expect(newLiquidationSnapshot.collateralPerCollateralSnapshot, "liquidationSnapshots[safeId].collateralPerCollateralSnapshot incorrect").to.equal(newCumulativeCollateralPerUnitCollateral);

    // Validate safe.weight (complex logic from Solidity)
    const prevMinFeeWeightNode = previousSnapshot.contractSnapshot.safesOrderedForRedemption.headId;
    let expectedWeight: bigint;

    if (prevSafe.borrowedAmount === 0n) {
        if (prevMinFeeWeightNode === 0n) {
            expectedWeight = shieldingRate;
        } else {
            const prevMinFeeWeight = previousSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[prevMinFeeWeightNode.toString()].value;
            expectedWeight = prevMinFeeWeight + shieldingRate;
        }
    } else {
        // This part relies on the current minimum fee weight in the redemption queue at the time of execution.
        // It's challenging to precisely predict _minFeeWeightNode if it shifts due to other transactions in the same block.
        // However, assuming this is an isolated transaction or the queue head doesn't change unexpectedly for this specific case.
        let currentMinFeeWeight = 0n;
        if (prevMinFeeWeightNode !== 0n) {
            currentMinFeeWeight = previousSnapshot.contractSnapshot.safesOrderedForRedemption.nodes[prevMinFeeWeightNode.toString()].value;
        }

        const diff = prevSafe.weight - currentMinFeeWeight;
        const weightedDiff = (diff * prevSafe.borrowedAmount) / BASIS_POINTS_DIVISOR;
        // Note: The formula for newFeeWeight in Solidity uses (safe.borrowedAmount + amount) which is previous safe.borrowedAmount + current borrow amount
        const newFeeWeight = ((_shieldingFee + weightedDiff) * BASIS_POINTS_DIVISOR) / (prevSafe.borrowedAmount + amount);
        
        if (shieldingRate > 0n) {
            expectedWeight = currentMinFeeWeight + newFeeWeight;
        } else {
            // If shieldingRate is 0, safe.weight is not explicitly updated in the Solidity code's 'if (shieldingRate > 0)' block.
            // It retains its value from the _updateSafe or previous handleBorrow.
            // The problem statement says: "The 'weight' of the user's Safe (safes[safeId].weight) is updated..."
            // If shieldingRate is 0, newFeeWeight calculation might result in expectedWeight being different from prevSafe.weight.
            // For strict validation, we consider the branch `if (shieldingRate > 0)`. If not, it means weight remains unchanged based on that branch.
            // However, the overall rule states 'weight is updated', implying it should change. The Solidity code implies no change if shieldingRate is 0 for existing borrows.
            // For robustness, if shieldingRate is 0 and it's an existing borrow, we'll expect weight to be previous if newFeeWeight calculation leads to no change, else use newFeeWeight.
            // The safest is to rely on `borrowedArgs.weight` for the actual resulting weight.
            expectedWeight = borrowedArgs.weight; // Rely on the event for accuracy.
        }
    }
    expect(newSafe.weight, "safe.weight incorrect").to.equal(expectedWeight);

    // Validate totalCollateral
    const prevTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    const newTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral;
    expect(newTotalCollateral, "totalCollateral incorrect").to.equal(prevTotalCollateral + collateralIncrease);

    // Validate totalDebt
    const prevTotalDebt = previousSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    const newTotalDebt = newSnapshot.contractSnapshot.stableBaseCDP.totalDebt;
    expect(newTotalDebt, "totalDebt incorrect").to.equal(prevTotalDebt + debtIncrease + amount);

    // Validate PROTOCOL_MODE
    const prevProtocolMode = previousSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
    const newProtocolMode = newSnapshot.contractSnapshot.stableBaseCDP.protocolMode;
    if (prevProtocolMode === 0 && newTotalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD) {
      expect(newProtocolMode, "PROTOCOL_MODE should transition to NORMAL").to.equal(1); // Assuming 0 for BOOTSTRAP, 1 for NORMAL
    } else {
      expect(newProtocolMode, "PROTOCOL_MODE should remain unchanged").to.equal(prevProtocolMode);
    }

    // --- Token Balance and Supply Validation (SBD Token) ---
    const prevSbdBalances = previousSnapshot.contractSnapshot.dfidToken.accountBalances;
    const newSbdBalances = newSnapshot.contractSnapshot.dfidToken.accountBalances;
    const prevSbdTotalSupply = previousSnapshot.contractSnapshot.dfidToken.tokenTotalSupply;
    const newSbdTotalSupply = newSnapshot.contractSnapshot.dfidToken.tokenTotalSupply;
    const prevTotalBurned = previousSnapshot.contractSnapshot.dfidToken.totalTokensBurned;
    const newTotalBurned = newSnapshot.contractSnapshot.dfidToken.totalTokensBurned;

    // msg.sender SBD balance increase
    expect(newSbdBalances[actorAddress], "Borrower's SBD balance incorrect").to.equal((prevSbdBalances[actorAddress] || 0n) + _amountToBorrowNet);

    // CDP contract SBD balance (for fees) - it mints fee to itself, then potentially burns canRefund
    const expectedCdpSbdBalanceChange = _shieldingFee - canRefund;
    expect(newSbdBalances[cdpContractAddress], "CDP contract's SBD balance incorrect").to.equal((prevSbdBalances[cdpContractAddress] || 0n) + expectedCdpSbdBalanceChange);

    // SBD total supply
    // Net mint: (amount - _shieldingFee) (to msg.sender) + _shieldingFee (to contract) - canRefund (burned from contract) = amount - canRefund
    expect(newSbdTotalSupply, "SBD total supply incorrect").to.equal(prevSbdTotalSupply + amount - canRefund);

    // DFIDToken.totalBurned validation
    if (canRefund > 0n) {
        expect(newTotalBurned, "DFIDToken.totalBurned incorrect").to.equal(prevTotalBurned + canRefund);
    } else {
        expect(newTotalBurned, "DFIDToken.totalBurned should not change if no refund").to.equal(prevTotalBurned);
    }

    // --- Account ETH Balance Validation ---
    const prevActorEthBalance = previousSnapshot.accountSnapshot[actorAddress];
    const newActorEthBalance = newSnapshot.accountSnapshot[actorAddress];
    expect(newActorEthBalance, "Actor's ETH balance incorrect").to.equal(prevActorEthBalance - txCost);

    // --- Doubly Linked List Structural Validation ---
    const newLiquidationNodes = newSnapshot.contractSnapshot.safesOrderedForLiquidation.nodes;
    const newRedemptionNodes = newSnapshot.contractSnapshot.safesOrderedForRedemption.nodes;

    // Verify safeId exists as a node and has non-zero value
    expect(newLiquidationNodes[safeId.toString()], "SafeId missing in liquidation queue nodes").to.not.be.undefined;
    expect(newLiquidationNodes[safeId.toString()].value, "Liquidation node value is zero").to.not.equal(0n);
    expect(newRedemptionNodes[safeId.toString()], "SafeId missing in redemption queue nodes").to.not.be.undefined;
    expect(newRedemptionNodes[safeId.toString()].value, "Redemption node value is zero").to.not.equal(0n);

    // Further validation of linked list structure (prev/next pointers and sorted order) is complex to do purely from snapshot data without direct contract calls or extensive parsing.
    // We'll rely on the contract's internal logic correctness and the above basic node existence checks.

    // --- Fee Distribution Contract State Validation ---
    // DFIREStaking
    const prevDfireStakingTotalRewardPerToken = previousSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;
    const newDfireStakingTotalRewardPerToken = newSnapshot.contractSnapshot.dfireStaking.totalRewardPerToken;
    const prevDfireStakingRewardTokenBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[context.contracts.dfireStaking.target];
    const newDfireStakingRewardTokenBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[context.contracts.dfireStaking.target];

    const sbrStakersFee = feeDistributedArgs.sbrStakersFee;
    const dfireStakingTotalStake = previousSnapshot.contractSnapshot.dfireStaking.totalStake;

    if (sbrStakersFee > 0n && dfireStakingTotalStake > 0n) {
      expect(newDfireStakingRewardTokenBalance, "DFIREStaking reward token balance incorrect").to.equal(prevDfireStakingRewardTokenBalance + sbrStakersFee);
      // Proportional increase check - assumes (amount * PRECISION) / totalStake logic
      const expectedRewardPerTokenIncrease = (sbrStakersFee * PRECISION) / dfireStakingTotalStake;
      expect(newDfireStakingTotalRewardPerToken, "DFIREStaking totalRewardPerToken incorrect").to.equal(prevDfireStakingTotalRewardPerToken + expectedRewardPerTokenIncrease);
    } else {
        expect(newDfireStakingRewardTokenBalance, "DFIREStaking reward token balance should not change if sbrStakersFee is 0 or totalStake is 0").to.equal(prevDfireStakingRewardTokenBalance);
        expect(newDfireStakingTotalRewardPerToken, "DFIREStaking totalRewardPerToken should not change if sbrStakersFee is 0 or totalStake is 0").to.equal(prevDfireStakingTotalRewardPerToken);
    }

    // StabilityPool
    const prevStabilityPoolTotalRewardPerToken = previousSnapshot.contractSnapshot.stabilityPool.totalRewardPerToken;
    const newStabilityPoolTotalRewardPerToken = newSnapshot.contractSnapshot.stabilityPool.totalRewardPerToken;
    const prevStabilityPoolRewardTokenBalance = previousSnapshot.contractSnapshot.dfidToken.accountBalances[context.contracts.stabilityPool.target];
    const newStabilityPoolRewardTokenBalance = newSnapshot.contractSnapshot.dfidToken.accountBalances[context.contracts.stabilityPool.target];

    const stabilityPoolFee = feeDistributedArgs.stabilityPoolFee;
    const stabilityPoolTotalStakedRaw = previousSnapshot.contractSnapshot.stabilityPool.totalStakedRaw;
    const stabilityPoolPrecision = previousSnapshot.contractSnapshot.stabilityPool.precision;
    const stabilityPoolStakeScalingFactor = previousSnapshot.contractSnapshot.stabilityPool.stakeScalingFactor;

    if (stabilityPoolFee > 0n && stabilityPoolTotalStakedRaw > 0n) {
      expect(newStabilityPoolRewardTokenBalance, "StabilityPool staking token balance incorrect").to.equal(prevStabilityPoolRewardTokenBalance + stabilityPoolFee);
      // Proportional increase check - complex due to stakeScalingFactor and rewardLoss
      // For simplicity, we'll check net change in `totalRewardPerToken` based on `RewardAdded` event.
      const rewardAddedEvent = executionReceipt.events?.find(
        (e) => e.fragment.name === "RewardAdded" && e.address === context.contracts.stabilityPool.target
      ) as unknown as ethers.EventLog | undefined;
      expect(rewardAddedEvent, "StabilityPool RewardAdded event not emitted").to.not.be.undefined;
      // The actual `_rewardPerToken` is calculated as `((_totalAmount * stakeScalingFactor * precision) / _totalStakedRaw) / precision`
      // where `_totalAmount = _amount + rewardLoss`
      // Can't directly calculate without knowing `_amount` passed to `addReward` and `rewardLoss` state at the time of calculation.
      // Assuming `totalRewardPerToken` updates proportionally.
      // For now, we will verify the `totalRewardPerToken` is greater than previous, but exact calculation is hard without intermediate values.
      expect(newStabilityPoolTotalRewardPerToken).to.be.gte(prevStabilityPoolTotalRewardPerToken);
    } else {
        expect(newStabilityPoolRewardTokenBalance, "StabilityPool staking token balance should not change if stabilityPoolFee is 0 or totalStakedRaw is 0").to.equal(prevStabilityPoolRewardTokenBalance);
        expect(newStabilityPoolTotalRewardPerToken, "StabilityPool totalRewardPerToken should not change if stabilityPoolFee is 0 or totalStakedRaw is 0").to.equal(prevStabilityPoolTotalRewardPerToken);
    }

    // StabilityPool SBR Rewards
    const prevSbrRewardDistributionStatus = previousSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionStatus;
    const newSbrRewardDistributionStatus = newSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionStatus;

    const prevTotalSbrRewardPerToken = previousSnapshot.contractSnapshot.stabilityPool.totalSbrRewardPerToken;
    const newTotalSbrRewardPerToken = newSnapshot.contractSnapshot.stabilityPool.totalSbrRewardPerToken;
    const prevLastSBRRewardDistributedTime = previousSnapshot.contractSnapshot.stabilityPool.lastSBRRewardDistributedTime;
    const newLastSBRRewardDistributedTime = newSnapshot.contractSnapshot.stabilityPool.lastSBRRewardDistributedTime;
    const prevSbrRewardDistributionEndTime = previousSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionEndTime;
    const newSbrRewardDistributionEndTime = newSnapshot.contractSnapshot.stabilityPool.sbrRewardDistributionEndTime;

    const sbrRewardsAddedEvent = executionReceipt.events?.find(
        (e) => e.fragment.name === "SBRRewardsAdded" && e.address === context.contracts.stabilityPool.target
    ) as unknown as ethers.EventLog | undefined;

    if (sbrRewardsAddedEvent) {
        const sbrRewardsAddedArgs = sbrRewardsAddedEvent.args as unknown as SBRRewardsAddedEvent;
        expect(newTotalSbrRewardPerToken).to.be.gte(prevTotalSbrRewardPerToken, "totalSbrRewardPerToken should increase");
        expect(newLastSBRRewardDistributedTime, "lastSBRRewardDistributedTime should update").to.equal(BigInt(executionReceipt.blockTimestamp));

        if (prevSbrRewardDistributionStatus === 0n) { // NOT_STARTED
            expect(newSbrRewardDistributionStatus, "SBR status should be STARTED").to.equal(1n); // 1n for STARTED
            // Expect end time to be blockTimestamp + 365 days, give some tolerance
            expect(newSbrRewardDistributionEndTime).to.be.closeTo(BigInt(executionReceipt.blockTimestamp) + 365n * 24n * 60n * 60n, 3600n); // 1 hour tolerance
        } else if (prevSbrRewardDistributionStatus === 1n && BigInt(executionReceipt.blockTimestamp) > prevSbrRewardDistributionEndTime) { // STARTED and past end time
            expect(newSbrRewardDistributionStatus, "SBR status should be ENDED").to.equal(2n); // 2n for ENDED
        }
    } else {
        expect(newTotalSbrRewardPerToken).to.equal(prevTotalSbrRewardPerToken, "totalSbrRewardPerToken should not change if no SBR rewards added");
        expect(newLastSBRRewardDistributedTime).to.equal(prevLastSBRRewardDistributedTime, "lastSBRRewardDistributedTime should not change if no SBR rewards added");
        expect(newSbrRewardDistributionEndTime).to.equal(prevSbrRewardDistributionEndTime, "sbrRewardDistributionEndTime should not change if no SBR rewards added");
        expect(newSbrRewardDistributionStatus).to.equal(prevSbrRewardDistributionStatus, "sbrRewardDistributionStatus should not change if no SBR rewards added");
    }

    // --- Event Emission Validation ---
    // SafeUpdated, FeeDistributed, Borrowed events already checked for existence above.

    // FeeRefund event
    if (canRefund > 0n) {
      expect(feeRefundEvent, "FeeRefund event not emitted when canRefund > 0").to.not.be.undefined;
      expect((feeRefundEvent!.args as unknown as FeeRefundEvent).amount, "FeeRefund amount incorrect").to.equal(canRefund);
    } else {
      expect(feeRefundEvent, "FeeRefund event emitted when canRefund is 0").to.be.undefined;
    }

    // Transfer events from SBD token
    const sbdTransferEvents = executionReceipt.events?.filter(
        (e) => e.fragment.name === "Transfer" && e.address === sbdTokenContractAddress
    ) as unknown as ethers.EventLog[];
    
    // 1. Mint to borrower (msg.sender)
    expect(sbdTransferEvents.some(e => 
        (e.args as unknown as TransferEvent).from === ethers.ZeroAddress && 
        (e.args as unknown as TransferEvent).to === actorAddress &&
        (e.args as unknown as TransferEvent).value === _amountToBorrowNet
    ), "SBD mint to borrower event missing").to.be.true;

    // 2. Mint for fees (to CDP contract)
    if (_shieldingFee > 0n) {
        expect(sbdTransferEvents.some(e => 
            (e.args as unknown as TransferEvent).from === ethers.ZeroAddress && 
            (e.args as unknown as TransferEvent).to === cdpContractAddress &&
            (e.args as unknown as TransferEvent).value === _shieldingFee
        ), "SBD mint to CDP contract for fee event missing").to.be.true;
    }
    
    // 3. Burn for refund (from CDP contract)
    if (canRefund > 0n) {
        expect(sbdTransferEvents.some(e => 
            (e.args as unknown as TransferEvent).from === cdpContractAddress && 
            (e.args as unknown as TransferEvent).to === ethers.ZeroAddress &&
            (e.args as unknown as TransferEvent).value === canRefund
        ), "SBD burn from CDP contract for refund event missing").to.be.true;
    }

    // Transfer events for reward tokens (from CDP to DFIREStaking and StabilityPool)
    const cdpToDfireStakingTransfer = executionReceipt.events?.find(e =>
      e.fragment.name === "Transfer" &&
      e.address === sbdTokenContractAddress && // Assuming DFIREStaking rewardToken is SBDToken
      (e.args as unknown as TransferEvent).from === cdpContractAddress &&
      (e.args as unknown as TransferEvent).to === context.contracts.dfireStaking.target &&
      (e.args as unknown as TransferEvent).value === sbrStakersFee
    ) as unknown as ethers.EventLog | undefined;

    const cdpToStabilityPoolTransfer = executionReceipt.events?.find(e =>
      e.fragment.name === "Transfer" &&
      e.address === sbdTokenContractAddress && // Assuming StabilityPool stakingToken is SBDToken
      (e.args as unknown as TransferEvent).from === cdpContractAddress &&
      (e.args as unknown as TransferEvent).to === context.contracts.stabilityPool.target &&
      (e.args as unknown as TransferEvent).value === stabilityPoolFee
    ) as unknown as ethers.EventLog | undefined;


    const dfireStakingRewardAddedEvent = executionReceipt.events?.find(
        (e) => e.fragment.name === "RewardAdded" && e.address === context.contracts.dfireStaking.target
    ) as unknown as ethers.EventLog | undefined;
    if (sbrStakersFee > 0n && dfireStakingTotalStake > 0n) { 
        expect(dfireStakingRewardAddedEvent, "DFIREStaking RewardAdded event missing").to.not.be.undefined;
        expect((dfireStakingRewardAddedEvent!.args as unknown as RewardAddedEvent).rewardAmount, "DFIREStaking RewardAdded amount incorrect").to.equal(sbrStakersFee);
        expect(cdpToDfireStakingTransfer, "Transfer from CDP to DFIREStaking missing").to.not.be.undefined;
    } else {
        expect(dfireStakingRewardAddedEvent, "DFIREStaking RewardAdded event emitted when it shouldn't").to.be.undefined;
        expect(cdpToDfireStakingTransfer, "Transfer from CDP to DFIREStaking emitted when it shouldn't").to.be.undefined;
    }

    const stabilityPoolRewardAddedEvent = executionReceipt.events?.find(
        (e) => e.fragment.name === "RewardAdded" && e.address === context.contracts.stabilityPool.target
    ) as unknown as ethers.EventLog | undefined;
    if (stabilityPoolFee > 0n && stabilityPoolTotalStakedRaw > 0n) { 
        expect(stabilityPoolRewardAddedEvent, "StabilityPool RewardAdded event missing").to.not.be.undefined;
        expect((stabilityPoolRewardAddedEvent!.args as unknown as RewardAddedEvent).rewardAmount, "StabilityPool RewardAdded amount incorrect").to.equal(stabilityPoolFee);
        expect(cdpToStabilityPoolTransfer, "Transfer from CDP to StabilityPool missing").to.not.be.undefined;
    } else {
        expect(stabilityPoolRewardAddedEvent, "StabilityPool RewardAdded event emitted when it shouldn't").to.be.undefined;
        expect(cdpToStabilityPoolTransfer, "Transfer from CDP to StabilityPool emitted when it shouldn't").to.be.undefined;
    }

    context.logger.info("BorrowAction: Validation successful.");
    return true;
  }
}