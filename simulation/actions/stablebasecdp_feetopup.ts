import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class FeeTopupAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("FeeTopupAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;
    const safeOwners = stableBaseCDPSnapshot.safeOwners;

    let safeId: bigint | undefined;
    for (const id in safeOwners) {
      if (safeOwners[id] === actor.account.address) {
        safeId = BigInt(id);
        break;
      }
    }

    if (!safeId) {
      console.log("No safe found for this actor");
      return [false, {}, {}];
    }

    const safe = stableBaseCDPSnapshot.safes[safeId.toString()];
    if (!safe) {
        console.log("Safe not found in snapshot");
        return [false, {}, {}];
    }

    // Initialize topupRate randomly based on snapshot data
    const maxTopupRate = BigInt(10000); // Example upper bound for topupRate
    const topupRate = BigInt(context.prng.next()) % maxTopupRate + BigInt(1); // Ensure topupRate > 0
    const nearestSpotInRedemptionQueue = BigInt(0); // Let the contract find it automatically for now

    return [true, { safeId, topupRate, nearestSpotInRedemptionQueue }, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { safeId, topupRate, nearestSpotInRedemptionQueue } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
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
    const stableBaseCDPPrevious = previousSnapshot.contractSnapshot.stableBaseCDP;
    const stableBaseCDPNew = newSnapshot.contractSnapshot.stableBaseCDP;
    const dfidTokenPrevious = previousSnapshot.contractSnapshot.dfidToken;
    const dfidTokenNew = newSnapshot.contractSnapshot.dfidToken;

    const previousSafe = stableBaseCDPPrevious.safes[safeId.toString()];
    const newSafe = stableBaseCDPNew.safes[safeId.toString()];

    // Safe State validation
    expect(newSafe.weight).to.equal(previousSafe.weight + topupRate, "Safe weight should be increased by topupRate");

    const fee = (topupRate * previousSafe.borrowedAmount) / BigInt(10000);
    expect(newSafe.feePaid).to.equal(previousSafe.feePaid + fee, "Safe feePaid should be increased by the calculated fee");

    // Token Balances validation
    const actorAddress = actor.account.address;
    const contractAddress = (this.contract as ethers.Contract).target;

    const previousActorBalance = dfidTokenPrevious.balances[actorAddress] || BigInt(0);
    const newActorBalance = dfidTokenNew.balances[actorAddress] || BigInt(0);
    const previousContractBalance = dfidTokenPrevious.balances[contractAddress] || BigInt(0);
    const newContractBalance = dfidTokenNew.balances[contractAddress] || BigInt(0);

    // Assuming no refund occurs for simplicity.  Refund logic needs event parsing.
    expect(newActorBalance).to.equal(previousActorBalance - fee, "Message sender's SBD balance should be decreased by the fee amount");
    expect(newContractBalance).to.equal(previousContractBalance + fee, "Contract's SBD balance should be increased by the fee amount");

    // Event Validation
    const feeTopupEvent = executionReceipt.receipt.logs.find(
      (log: any) =>
        log.address === contractAddress &&
        log.topics[0] === ethers.id("FeeTopup(uint256,uint256,uint256,uint256)")
    );

    expect(feeTopupEvent).to.not.be.undefined, "FeeTopup event should be emitted";

    if (feeTopupEvent) {
      const parsedEvent = new ethers.Interface(["event FeeTopup(uint256 safeId, uint256 topupRate, uint256 fee, uint256 newWeight)"]).parseLog(feeTopupEvent);
      expect(parsedEvent.args.safeId).to.equal(safeId, "FeeTopup event safeId mismatch");
      expect(parsedEvent.args.topupRate).to.equal(topupRate, "FeeTopup event topupRate mismatch");
      expect(parsedEvent.args.fee).to.equal(fee, "FeeTopup event fee mismatch");
      expect(parsedEvent.args.newWeight).to.equal(newSafe.weight, "FeeTopup event newWeight mismatch");
    }

        //RedemptionQueueUpdated event validation
    const redemptionQueueUpdatedEvent = executionReceipt.receipt.logs.find(
        (log: any) =>
          log.address === contractAddress &&
          log.topics[0] === ethers.id("RedemptionQueueUpdated(uint256,uint256,uint256)")
      );

      expect(redemptionQueueUpdatedEvent).to.not.be.undefined, "RedemptionQueueUpdated event should be emitted";
    
      if(redemptionQueueUpdatedEvent){
        const parsedEvent = new ethers.Interface(["event RedemptionQueueUpdated(uint256 safeId, uint256 weight, uint256 prev)"]).parseLog(redemptionQueueUpdatedEvent);
          expect(parsedEvent.args.safeId).to.equal(safeId, "RedemptionQueueUpdated event safeId mismatch");
          expect(parsedEvent.args.weight).to.equal(newSafe.weight, "RedemptionQueueUpdated event weight mismatch");
      }

    // FeeDistributed event validation
    const feeDistributedEvent = executionReceipt.receipt.logs.find(
      (log: any) =>
        log.address === contractAddress &&
        log.topics[0] === ethers.id("FeeDistributed(uint256,uint256,bool,uint256,uint256,uint256)")
    );

    expect(feeDistributedEvent).to.not.be.undefined, "FeeDistributed event should be emitted";


    //Total debt validation
    expect(stableBaseCDPNew.totalDebt).to.gte(stableBaseCDPPrevious.totalDebt, "Total debt should be greater than or equal to previous total debt");

    //PROTOCOL_MODE validation - verify that if totalDebt becomes greater than BOOTSTRAP_MODE_DEBT_THRESHOLD, the PROTOCOL_MODE is changed to NORMAL
    if (
        stableBaseCDPNew.totalDebt > stableBaseCDPPrevious.bootstrapModeDebtThreshold &&
        stableBaseCDPPrevious.protocolMode == 0 //SBStructs.Mode.BOOTSTRAP
    ) {
        expect(stableBaseCDPNew.protocolMode).to.equal(1); //SBStructs.Mode.NORMAL
    }


    return true;
  }
}
