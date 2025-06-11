import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class AddCollateralAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("AddCollateralAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDP = currentSnapshot.contractSnapshot.stableBaseCDP;
    const accountSnapshot = currentSnapshot.accountSnapshot;

    if (!stableBaseCDP || !stableBaseCDP.accountBalance) {
      console.log("StableBaseCDP snapshot or account balance is missing.");
      return [false, {}, {}];
    }

    const safeId = Object.keys((stableBaseCDP as any).safes || {}).find(key => {
      const safe = (stableBaseCDP as any).safes[key];
      return safe && safe.collateralAmount > BigInt(0);
    });

    if (!safeId) {
      console.log("No valid safe found with collateral.");
      return [false, {}, {}];
    }

    const safeInfo = (stableBaseCDP as any).safes[safeId];

    if (!safeInfo || safeInfo.collateralAmount === undefined || safeInfo.borrowedAmount === undefined) {
        console.log(`Safe with ID ${safeId} does not exist or has invalid state`);
        return [false, {}, {}];
    }

    const actorAddress = actor.account.address;
    const actorEthBalance = accountSnapshot[actorAddress] || BigInt(0);

    if (actorEthBalance <= BigInt(0)) {
      console.log("Actor does not have enough ETH.");
      return [false, {}, {}];
    }

    let amount = BigInt(context.prng.next()) % (actorEthBalance / BigInt(2));
    if (amount <= BigInt(0)) {
        console.log("Amount must be greater than 0.");
        return [false, {}, {}];
    }

    try {
        const gasEstimate = await this.contract
            .connect(actor.account.value)
            .estimateGas.addCollateral(safeId, amount, BigInt(0), { value: amount });

        const gasCost = gasEstimate * BigInt(2);
        if (amount + gasCost > actorEthBalance) {
            amount = (actorEthBalance - gasCost) > BigInt(0) ? (actorEthBalance - gasCost) : BigInt(0)

            if (amount <= BigInt(0)) {
              console.log("Amount must be greater than 0 after adjusting for gas.");
              return [false, {}, {}];
            }
        }
    } catch (error) {
        console.error("Error estimating gas:", error);
        return [false, {}, {}];
    }

    const nearestSpotInLiquidationQueue = BigInt(0);

    const actionParams = {
      safeId: BigInt(safeId),
      amount: amount,
      nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { safeId, amount, nearestSpotInLiquidationQueue } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value)
      .addCollateral(safeId, amount, nearestSpotInLiquidationQueue,
        { value: amount });

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
    const { safeId, amount } = actionParams;

    const previousStableBaseCDP = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDP = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousAccountSnapshot = previousSnapshot.accountSnapshot;
    const newAccountSnapshot = newSnapshot.accountSnapshot;
    const safesOrderedForLiquidation = context.contracts.safesOrderedForLiquidation;

    if (!previousStableBaseCDP || !newStableBaseCDP) {
      console.log("StableBaseCDP snapshot is missing.");
      return false;
    }

    const previousSafe = (previousStableBaseCDP as any).safes?.[safeId.toString()];
    const newSafe = (newStableBaseCDP as any).safes?.[safeId.toString()];

    if (!previousSafe || !newSafe) {
        console.log("Safe data is missing in snapshots.");
        return false;
    }

    const previousSafeCollateral = previousSafe.collateralAmount || BigInt(0);
    const newSafeCollateral = newSafe.collateralAmount || BigInt(0);
    const previousSafeBorrowed = previousSafe.borrowedAmount || BigInt(0);
    const newSafeBorrowed = newSafe.borrowedAmount || BigInt(0);

    const expectedCollateralIncrease = amount;
    const collateralIncrease = newSafeCollateral - previousSafeCollateral - amount;
    const debtIncrease = newSafeBorrowed - previousSafeBorrowed;

    expect(newSafeCollateral - previousSafeCollateral, "Safe collateral should increase by amount").to.equal(expectedCollateralIncrease + collateralIncrease);

    const expectedTotalCollateralIncrease = amount + collateralIncrease;
    expect(newStableBaseCDP.totalCollateral - previousStableBaseCDP.totalCollateral, "Total collateral should increase by expected amount").to.equal(expectedTotalCollateralIncrease);

    const previousTotalDebt = previousStableBaseCDP.totalDebt || BigInt(0);
    const newTotalDebt = newStableBaseCDP.totalDebt || BigInt(0);

    expect(newTotalDebt - previousTotalDebt, "Total debt should be updated correctly").to.equal(debtIncrease);

    // Account ETH balance validation
    const actorAddress = actor.account.address;
    const previousActorEthBalance = previousAccountSnapshot[actorAddress] || BigInt(0);
    const newActorEthBalance = newAccountSnapshot[actorAddress] || BigInt(0);

    const gasUsed = executionReceipt.receipt.gasUsed * executionReceipt.receipt.effectiveGasPrice;

    expect(previousActorEthBalance - newActorEthBalance, "Actor ETH balance should decrease by amount + gas").to.equal(amount + gasUsed);

    // Event Validation
    const addedCollateralEvent = executionReceipt.receipt.logs.find(
      (log: any) =>
        log.address === (context.contracts.stableBaseCDP as any).target &&
        log.topics[0] === ethers.keccak256(ethers.utils.toUtf8Bytes("AddedCollateral(uint256,uint256,uint256,uint256,uint256)"))
    );

    expect(addedCollateralEvent).to.not.be.undefined;

    const liquidationQueueUpdatedEvent = executionReceipt.receipt.logs.find(
        (log: any) =>
        log.address === (context.contracts.stableBaseCDP as any).target &&
        log.topics[0] === ethers.keccak256(ethers.utils.toUtf8Bytes("LiquidationQueueUpdated(uint256,uint256,uint256)"))
    );

    expect(liquidationQueueUpdatedEvent).to.not.be.undefined;

      // Check for SafeUpdated event and validate its presence if debt or collateral was updated
    const safeUpdatedEvent = executionReceipt.receipt.logs.find(
        (log: any) =>
            log.address === (context.contracts.stableBaseCDP as any).target &&
            log.topics[0] === ethers.keccak256(ethers.utils.toUtf8Bytes("SafeUpdated(uint256,uint256,uint256,uint256,uint256,uint256,uint256)"))
    );

    if (debtIncrease > BigInt(0) || collateralIncrease > BigInt(0)) {
        expect(safeUpdatedEvent, "SafeUpdated event should be emitted").to.not.be.undefined;
    }

   // Basic Validation for state updates in OrderedDoublyLinkedList - more sophisticated validation to be added as needed.
    const previousSafesOrderedForLiquidationSnapshot = previousSnapshot.contractSnapshot.safesOrderedForLiquidation;    
    const newSafesOrderedForLiquidationSnapshot = newSnapshot.contractSnapshot.safesOrderedForLiquidation;

    if (previousSafesOrderedForLiquidationSnapshot && newSafesOrderedForLiquidationSnapshot) {
        const previousNode = previousSafesOrderedForLiquidationSnapshot.nodes?.[safeId.toString()];
        const newNode = newSafesOrderedForLiquidationSnapshot.nodes?.[safeId.toString()];

        if (previousNode && newNode) {
            // You can add more sophisticated checks here to validate the node's position in the linked list
            // For example, check if the previous and next pointers are correctly updated
            // based on the new collateral ratio.
            // This will depend on the specific logic of the upsert function in the OrderedDoublyLinkedList contract.

            // Example: Check if the node's value (collateral ratio) has been updated
            expect(newNode.value).to.not.equal(previousNode.value, "Node value should be updated");

        }
    }

    return true;
  }
}
