import { Action, Actor, Snapshot } from "@svylabs/ilumina";
import type RunContext, { ExecutionReceipt } from "@svylabs/ilumina";
import { ethers } from "ethers";
import { expect } from 'chai';

export class CloseSafeAction extends Action {
  contract: ethers.Contract;

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
    const actorAddress = actor.account.address;

    let safeIdToClose: number | undefined = undefined;
    for (const safeId in stableBaseCDPSnapshot.safes) {
      if (stableBaseCDPSnapshot.safes.hasOwnProperty(safeId)) {
        const safe = stableBaseCDPSnapshot.safes[safeId];
        // Check if the safe exists and borrowedAmount is 0
        if (safe && safe.borrowedAmount === BigInt(0)) {
          //  Attempt to call the contract's ownerOf function to check ownership
          try {
            const owner = await this.contract.ownerOf(safeId);
            if (owner.toLowerCase() === actorAddress.toLowerCase()) {
              safeIdToClose = parseInt(safeId, 10);
              break;
            }
          } catch (error) {
            console.warn(`Could not verify ownership for safeId ${safeId}: ${error}`);
            // If ownerOf reverts, it's likely not owned by anyone (or doesn't exist), so continue to the next safe
            continue;
          }
        }
      }
    }

    if (safeIdToClose === undefined) {
      console.log("No suitable Safe found to close.");
      return [false, {}, {}];
    }

    console.log(`Attempting to close Safe with ID: ${safeIdToClose}`);

    const actionParams = {
      safeId: safeIdToClose,
    };

    return [true, actionParams, {}];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const signer = actor.account.value.connect(this.contract.provider);
    this.contract = this.contract.connect(signer);

    try {
      const tx = await this.contract.closeSafe(actionParams.safeId);
      const receipt = await tx.wait();
      console.log(`Closed Safe with ID: ${actionParams.safeId}, Transaction Hash: ${receipt.hash}`);
      return { transactionHash: receipt.hash };
    } catch (error: any) {
      console.error(`Failed to close Safe with ID: ${actionParams.safeId}: ${error.message}`);
      throw error;
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
    const safeId = actionParams.safeId;
    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;
    const actorAddress = actor.account.address;

    try {
      // Safe should be deleted from the safes mapping
      expect(newStableBaseCDPSnapshot.safes[safeId]).to.be.undefined;

      // ERC721 token should be burned, check ownerOf returns address(0)
      const ERC721Contract = new ethers.Contract(this.contract.target, ['function ownerOf(uint256 tokenId) external view returns (address)'], context.contracts.stableBaseCDP.provider);
      const newOwner = await ERC721Contract.ownerOf(safeId);
      expect(newOwner).to.equal(ethers.constants.AddressZero, "ERC721 token should be burned (owner should be address(0))");

      // Get the collateral amount before closing the safe
      const previousCollateralAmount = previousStableBaseCDPSnapshot.safes[safeId]?.collateralAmount || BigInt(0);

      // Get previous total debt and collateral
          const previousTotalDebt = previousStableBaseCDPSnapshot.totalDebt;
          const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;

      // Total collateral calculation
      const expectedTotalCollateral = previousTotalCollateral - previousCollateralAmount;
      expect(newStableBaseCDPSnapshot.totalCollateral).to.equal(expectedTotalCollateral, "Total collateral should be decreased by the collateral amount of the closed Safe");

          //Check total debt
          const expectedTotalDebt = previousTotalDebt;
          expect(newStableBaseCDPSnapshot.totalDebt).to.equal(expectedTotalDebt, "Total debt should remain the same");

      // Account balance validation
      const previousAccountBalance = previousSnapshot.accountSnapshot[actorAddress] || BigInt(0);
      const newAccountBalance = newSnapshot.accountSnapshot[actorAddress] || BigInt(0);
      const gasUsed = executionReceipt.gasUsed;
      const gasPrice = executionReceipt.gasPrice;
      const transactionFee = gasUsed * gasPrice;

      // Assuming all collateral is sent back to the user minus transaction fees.
      const expectedBalanceIncrease = previousCollateralAmount - transactionFee;
      const actualBalanceIncrease = newAccountBalance - previousAccountBalance;

      //Allow a small tolerance for gas estimation differences
      const tolerance = BigInt(1000);
      expect(actualBalanceIncrease).to.be.closeTo(expectedBalanceIncrease, tolerance, "Account balance should increase by collateral amount minus transaction fees");

          // Check for SafeClosed and RemovedSafe events
      let safeClosedEventEmitted = false;
      let removedSafeEventEmitted = false;

      for (const log of executionReceipt.logs) {
          if (log.address.toLowerCase() === this.contract.target.toLowerCase()) {
              try {
                  const parsedLog = this.contract.interface.parseLog(log);
                  if (parsedLog.name === 'SafeClosed') {
                      expect(parsedLog.args.safeId).to.equal(BigInt(safeId), 'SafeClosed event should have the correct safeId');
                      expect(parsedLog.args.collateralAmount).to.equal(previousCollateralAmount, 'SafeClosed event should have the correct collateralAmount');
                      safeClosedEventEmitted = true;
                  } else if (parsedLog.name === 'RemovedSafe') {
                      expect(parsedLog.args._safeId).to.equal(BigInt(safeId), 'RemovedSafe event should have the correct safeId');
                      removedSafeEventEmitted = true;
                  }
              } catch (error) {
                  // Skip if the log cannot be parsed
              }
          }
      }

      expect(safeClosedEventEmitted, 'SafeClosed event should be emitted').to.be.true;
      expect(removedSafeEventEmitted, 'RemovedSafe event should be emitted').to.be.true;

      return true;
    } catch (error: any) {
      console.error("Validation failed: ", error);
      return false;
    }
  }
}
