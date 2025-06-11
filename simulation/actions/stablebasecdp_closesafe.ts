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
    const stableBaseCDPContract = context.contracts.stableBaseCDP as ethers.Contract;
    const safeId = Object.keys(currentSnapshot.contractSnapshot.stableBaseCDP.safes)
      .map(Number)
      .find((id) => {
        const safe = currentSnapshot.contractSnapshot.stableBaseCDP.safes[id];
        const safeOwner = currentSnapshot.contractSnapshot.stableBaseCDP.safeOwners[id];
        return safe && safe.borrowedAmount === BigInt(0) && safeOwner === actor.account.address;
      });

    if (!safeId) {
      return [false, {}, {}];
    }

    return [true, { safeId: BigInt(safeId) }, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<ExecutionReceipt> {
    const { safeId } = actionParams;

    const tx = await this.contract
      .connect(actor.account.value as ethers.Signer)
      .closeSafe(safeId);
    const receipt = await tx.wait();
    return { receipt: receipt, events: receipt.events || [] };
  }

  async validate(
    context: RunContext,
    actor: Actor,
    previousSnapshot: Snapshot,
    newSnapshot: Snapshot,
    actionParams: any,
    executionReceipt: ExecutionReceipt
  ): Promise<boolean> {
    const { safeId } = actionParams;
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    // Safe should not exist in the new snapshot
    expect(newStableBaseCDPSnapshot.safes[safeId]).to.be.undefined;

    // ownerOf(safeId) should return address(0)
    const owner = newStableBaseCDPSnapshot.safeOwners[safeId];
    expect(owner).to.be.undefined;

    // totalCollateral should decrease by the closed Safe's collateral amount
    const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
    const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
    const safeCollateralAmount = previousStableBaseCDPSnapshot.safes[safeId].collateralAmount;
    expect(newTotalCollateral).to.equal(previousTotalCollateral - safeCollateralAmount);

    // totalDebt should reflect cumulative interest and repayments. This is hard to validate precisely, so check it doesn't increase drastically.
    const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
    const newTotalDebt = newStableBaseCDPSnapshot.totalDebt;
    expect(newTotalDebt).to.be.lte(previousTotalDebt);

    // If totalDebt is above BOOTSTRAP_MODE_DEBT_THRESHOLD, PROTOCOL_MODE should be NORMAL.
    const bootstrapModeDebtThreshold = previousStableBaseCDPSnapshot.bootstrapModeDebtThreshold;
    if (newTotalDebt > bootstrapModeDebtThreshold) {
      expect(newStableBaseCDPSnapshot.protocolMode).to.equal(1); // Assuming NORMAL is 1.
    }

    // ERC721 validations - Check token balances
    const previousBalance = previousSnapshot.contractSnapshot.stableBaseCDP.accountBalances?.[actor.account.address] || BigInt(0);
    const newBalance = newSnapshot.contractSnapshot.stableBaseCDP.accountBalances?.[actor.account.address] || BigInt(0);

    // Check for SafeClosed event
    const safeClosedEvent = executionReceipt.events.find(
      (event: any) => event.event === "SafeClosed" && event.args[0].toString() === safeId.toString()
    );
    expect(safeClosedEvent).to.not.be.undefined;


    return true;
  }
}
