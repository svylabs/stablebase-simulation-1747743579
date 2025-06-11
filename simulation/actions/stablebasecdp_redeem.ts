import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class RedeemAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("RedeemAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
    const dfidTokenSnapshot = currentSnapshot.contractSnapshot.dfidToken;
    const actorAddress = actor.account.address;

    const actorBalance = dfidTokenSnapshot.balances[actorAddress] || BigInt(0);

    if (actorBalance <= BigInt(0)) {
      return [false, {}, {}];
    }

    //Generate random amount based on actor balance
    const amount = BigInt(Math.floor(context.prng.next() % Number(actorBalance)));
    const nearestSpotInLiquidationQueue = BigInt(0);

    if (amount <= BigInt(0)) {
      return [false, {}, {}];
    }

    const canExecute = amount > BigInt(0);

    const actionParams = canExecute
      ? {
          amount: amount,
          nearestSpotInLiquidationQueue: nearestSpotInLiquidationQueue,
        }
      : {};

    return [canExecute, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const signer = actor.account.value.connect(context.provider);
    const tx = await this.contract
      .connect(signer)
      .redeem(
        actionParams.amount,
        actionParams.nearestSpotInLiquidationQueue
      );
    const receipt = await tx.wait();
    return { receipt: receipt, result: null };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const amount = actionParams.amount;
    // Contract Snapshots
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const previousDFIDTokenSnapshot = previousSnapshot.contractSnapshot.dfidToken;
    const newDFIDTokenSnapshot = newSnapshot.contractSnapshot.dfidToken;
    const previousStabilityPoolSnapshot = previousSnapshot.contractSnapshot.stabilityPool;
    const newStabilityPoolSnapshot = newSnapshot.contractSnapshot.stabilityPool;

    // Contract Addresses
    const stableBaseCDPAddress = (context.contracts.stableBaseCDP as ethers.Contract).target;
    const dfidTokenAddress = (context.contracts.dfidToken as ethers.Contract).target;
    const stabilityPoolAddress = (context.contracts.stabilityPool as ethers.Contract).target;

    // Account Snapshots
    const previousAccountSnapshot = previousSnapshot.accountSnapshot;
    const newAccountSnapshot = newSnapshot.accountSnapshot;
    const actorAddress = actor.account.address;

    // Actor ETH Balance Validation
    const prevActorETHBalance = previousAccountSnapshot[actorAddress] || BigInt(0);
    const newActorETHBalance = newAccountSnapshot[actorAddress] || BigInt(0);

    // Actor SBD Balance Validation
    const prevActorSBDBalance = previousDFIDTokenSnapshot.balances[actorAddress] || BigInt(0);
    const newActorSBDBalance = newDFIDTokenSnapshot.balances[actorAddress] || BigInt(0);

    // StableBaseCDP SBD Balance Validation
    const prevStableBaseCDPSBDBalance = previousDFIDTokenSnapshot.balances[stableBaseCDPAddress] || BigInt(0);
    const newStableBaseCDPSBDBalance = newDFIDTokenSnapshot.balances[stableBaseCDPAddress] || BigInt(0);

    // Total Supply Validation
    const prevTotalSupply = previousDFIDTokenSnapshot.totalSupply;
    const newTotalSupply = newDFIDTokenSnapshot.totalSupply;

    // Total Burned Validation
    const prevTotalBurned = previousDFIDTokenSnapshot.totalBurned;
    const newTotalBurned = newDFIDTokenSnapshot.totalBurned;

    // Total Collateral Validation
    const prevTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;

    // Total Debt Validation
    const prevTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    // Event Validation
    let redeemedBatchEvent;
    try {
        redeemedBatchEvent = executionReceipt.receipt.logs.find((log: any) => {
            try {
                const parsedLog = this.contract.interface.parseLog(log);
                return parsedLog && parsedLog.name === 'RedeemedBatch';
            } catch (e) {
                return false;
            }
        });
    } catch (error) {
        console.error("Error parsing logs:", error);
        return false;
    }

    //RedeemedBatch event validation
    if(redeemedBatchEvent) {
        let parsedRedeemBatchEvent;
        try {
             parsedRedeemBatchEvent = this.contract.interface.parseLog(redeemedBatchEvent);
        } catch (error) {
            console.error("Error parsing RedeemedBatch event:", error);
            return false;
        }

        expect(parsedRedeemBatchEvent.args.amount).to.equal(amount, "RedeemedBatch: Amount mismatch");
        expect(newTotalCollateral).to.equal(parsedRedeemBatchEvent.args.totalCollateral, "RedeemedBatch: Total Collateral mismatch");
        expect(newTotalDebt).to.equal(parsedRedeemBatchEvent.args.totalDebt, "RedeemedBatch: Total Debt mismatch");
    }
    else {
         console.warn("RedeemedBatch event not found. Validation may be incomplete.");
    }

    // Check that SBD was transferred from the redeemer to the contract
    expect(newActorSBDBalance).to.equal(prevActorSBDBalance - amount, "SBD not transferred from redeemer");
    expect(newStableBaseCDPSBDBalance).to.equal(prevStableBaseCDPSBDBalance + amount, "SBD not transferred to contract");

    // Check that SBD was burned
    expect(newTotalSupply).to.be.lte(prevTotalSupply, "SBD not burned");
    expect(newTotalBurned).to.be.gte(prevTotalBurned, "totalBurned incorrect");

    // Check that totalCollateral decreased (by an amount that's hard to predict exactly)
    expect(newTotalCollateral).to.be.lte(prevTotalCollateral, "totalCollateral did not decrease");

    // Check that totalDebt decreased (by amount)
    expect(newTotalDebt).to.be.lte(prevTotalDebt, "totalDebt did not decrease");

    // Check that the actor received ETH (redeemed collateral)
    expect(newActorETHBalance).to.be.gt(prevActorETHBalance, "ETH not received by redeemer");

    return true;
  }
}
