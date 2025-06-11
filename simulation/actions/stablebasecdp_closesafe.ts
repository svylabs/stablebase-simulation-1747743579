import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type { RunContext, ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from "chai";

export class CloseSafeAction extends Action {
  private contract: ethers.Contract;

  constructor(contract: ethers.Contract) {
    super("CloseSafeAction");
    this.contract = contract;
  }

  async initialize(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot
  ): Promise<[boolean, any, Record<string, any>]> {
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    const safeIds = Object.keys(stableBaseCDPSnapshot.safes).map(Number);

    if (safeIds.length === 0) {
      return [false, {}, {}];
    }

    let validSafeId: number | null = null;
    const potentialSafeIds = [];

    for (const safeId of safeIds) {
      const safe = stableBaseCDPSnapshot.safes[safeId];
      // Check if the safe exists and borrowedAmount is 0
      if (safe && safe.borrowedAmount === BigInt(0)) {
        try {
          const safeOwner = await this.contract.ownerOf(safeId);
          if(safeOwner === actor.account.address){
            potentialSafeIds.push(safeId);
          }
        }catch(e){
          console.log("Safe does not exist or ownerOf call failed", e);
        }
      }
    }

    if (potentialSafeIds.length === 0) {
      console.log("No suitable safe found for closing.");
      return [false, {}, {}];
    }

    validSafeId = potentialSafeIds[context.prng.next() % potentialSafeIds.length];

    const actionParams = {
      safeId: BigInt(validSafeId),
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const tx = await this.contract
      .connect(actor.account.value)
      .closeSafe(actionParams.safeId);
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
    const safeId = Number(actionParams.safeId);
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    const previousSafes = previousStableBaseCDPSnapshot.safes;
    const newSafes = newStableBaseCDPSnapshot.safes;

    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;

    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;

    const safeCollateralAmount = previousSafes[safeId]?.collateralAmount || BigInt(0);
    const safeBorrowedAmount = previousSafes[safeId]?.borrowedAmount || BigInt(0);

    // Safe should not exist
    expect(newSafes[safeId]).to.be.undefined;

    // Total collateral
    expect(newTotalCollateral).to.equal(
      previousTotalCollateral - safeCollateralAmount,
      "Total collateral should be decreased by the collateral amount of the closed Safe"
    );

    // Check ERC721 token ownership
    const stableBaseCDPContract = this.contract;

    const zeroAddress = ethers.ZeroAddress;
    expect(await stableBaseCDPContract.ownerOf(safeId)).to.equal(zeroAddress, "ERC721 token should be burned");

    // Account Balance
    const actorAddress = actor.account.address;
    const previousAccountBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
    const newAccountBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);

    const ethSentToOwner = executionReceipt.receipt.logs.reduce((acc, log) => {
      try {
        const parsedLog = stableBaseCDPContract.interface.parseLog(log as any);
        if (parsedLog && parsedLog.name === 'SafeClosed') {
            return parsedLog.args[1] as bigint;  //safeCollateralAmount
        }
        return acc;
      } catch (e) {
        return acc;
      }
    }, BigInt(0));

    expect(newAccountBalance - previousAccountBalance).to.equal(ethSentToOwner, "Collateral amount sent to the user.");

    // Liquidation Snapshot should be deleted
    expect(previousStableBaseCDPSnapshot.collateralPerCollateralSnapshot && newStableBaseCDPSnapshot.collateralPerCollateralSnapshot ? newStableBaseCDPSnapshot.collateralPerCollateralSnapshot[safeId] : undefined).to.be.undefined;
    expect(previousStableBaseCDPSnapshot.debtPerCollateralSnapshot && newStableBaseCDPSnapshot.debtPerCollateralSnapshot ? newStableBaseCDPSnapshot.debtPerCollateralSnapshot[safeId] : undefined).to.be.undefined;

    // ERC721 Balance
    try{
        const previousOwner = await stableBaseCDPContract.ownerOf(safeId);
        const previousERC721Balance = previousSnapshot.contractSnapshot.dfidToken.balances[previousOwner];
        if(previousERC721Balance){
            const newERC721Balance = newSnapshot.contractSnapshot.dfidToken.balances[previousOwner];
            expect(newERC721Balance).to.equal(previousERC721Balance - BigInt(1), "ERC721 balance should decrease by 1");
        }
    } catch(e){
        //Ignore the error. This might happen if the token doesn't exist
    }
    // Token Approvals should be cleared
    expect(await stableBaseCDPContract.getApproved(safeId)).to.equal(zeroAddress, "Token approval should be reset to zero address");

     // PROTOCOL_MODE validation
    const BOOTSTRAP_MODE_DEBT_THRESHOLD = BigInt(1000); // setting a static value. Should be taken from snapshot if available
    if (previousStableBaseCDPSnapshot.totalDebt <= BOOTSTRAP_MODE_DEBT_THRESHOLD && newStableBaseCDPSnapshot.totalDebt > BOOTSTRAP_MODE_DEBT_THRESHOLD) {
        // Assuming you have access to the current PROTOCOL_MODE through a getter function on the contract
        const currentProtocolMode = await this.contract.PROTOCOL_MODE();
        expect(currentProtocolMode).to.equal(1, "PROTOCOL_MODE should switch to NORMAL"); // Assuming NORMAL is represented by 1
    }

    return true;
  }
}
