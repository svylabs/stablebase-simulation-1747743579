import { ethers } from "ethers";
import { expect } from 'chai';
import { Actor, RunContext, Snapshot, Action } from "@svylabs/ilumia";

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
  ): Promise<[any, Record<string, any>]> {
    // Fetch the safeIds owned by the actor
    const safeIds: bigint[] = [];
    const stableBaseCDPSnapshot = currentSnapshot.contractSnapshot.stableBaseCDP;

    if (stableBaseCDPSnapshot && stableBaseCDPSnapshot.ownerOf) {
      for (const safeId in stableBaseCDPSnapshot.ownerOf) {
        if (stableBaseCDPSnapshot.ownerOf[safeId] === actor.account.address) {
          safeIds.push(BigInt(safeId));
        }
      }
    }

    if (safeIds.length === 0) {
      throw new Error("No safes owned by the actor. Cannot close safe, no safes owned.");
    }

    // Select a random safeId from the owned safeIds
    const safeIdIndex = context.prng.next() % BigInt(safeIds.length);
    const safeId = safeIds[Number(safeIdIndex)];

    // Action parameters are simple arguments to the contract
    const actionParams = [safeId];

    // No new identifiers are created in this action
    const newIdentifiers: Record<string, any> = {};

    context.logger.debug(`Closing safe with safeId: ${safeId}`);

    return [actionParams, newIdentifiers];
  }

  async execute(
    context: RunContext,
    actor: Actor,
    currentSnapshot: Snapshot,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const safeId = actionParams[0];

    // Ensure the safeId is a BigInt
    if (typeof safeId !== 'bigint') {
      throw new Error('safeId must be a BigInt');
    }

    // Convert safeId to a number for calling the contract
    const safeIdNumber = Number(safeId);
    try {
      // Call the contract function using the Hardhat signer
      const tx = await this.contract.connect(actor.account.value).closeSafe(safeIdNumber);
      context.logger.debug(`Transaction hash: ${tx.hash}`);
      await tx.wait(); // Wait for the transaction to be mined
      context.logger.debug(`Transaction confirmed for closing safeId: ${safeId}`);

    }
    catch (error: any) {
      context.logger.error(`Error during contract execution: ${error.message || error}`);
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
    const safeIdNumber = Number(safeId);

    const previousStableBaseCDPSnapshot = previousSnapshot.contractSnapshot.stableBaseCDP;
    const newStableBaseCDPSnapshot = newSnapshot.contractSnapshot.stableBaseCDP;

    // 1. Safe Closure
    if (newStableBaseCDPSnapshot && newStableBaseCDPSnapshot.safes && newStableBaseCDPSnapshot.safes[safeId]) {
      expect(newStableBaseCDPSnapshot.safes[safeId]).to.be.undefined; // Use undefined to check if the value doesn't exist
    } else {
      context.logger.warn("Safe was not properly cleared from the safes mapping.");
    }

    // Assuming collateral is transferred to msg.sender,
    // We check the actor's ETH balance has increased by previous collateral amount.
    if (previousStableBaseCDPSnapshot && previousStableBaseCDPSnapshot.safes && previousStableBaseCDPSnapshot.safes[safeId]) {
      const previousCollateralAmount = previousStableBaseCDPSnapshot.safes[safeId].collateralAmount;
      const previousAccountBalance = previousSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
      const newAccountBalance = newSnapshot.accountSnapshot[actor.account.address] || BigInt(0);
      const expectedBalanceIncrease = previousCollateralAmount || BigInt(0);

      expect(newAccountBalance - previousAccountBalance).to.be.gte(expectedBalanceIncrease, "Collateral amount should have been transferred to the transaction sender (msg.sender).");
    } else {
      context.logger.warn("Previous safe snapshot missing or safe doesn't exist.");
    }

    // Validate totalCollateral decrease
    if (previousStableBaseCDPSnapshot && previousStableBaseCDPSnapshot.totalCollateral && newStableBaseCDPSnapshot && newStableBaseCDPSnapshot.totalCollateral && previousStableBaseCDPSnapshot.safes && previousStableBaseCDPSnapshot.safes[safeId]) {
      const previousTotalCollateral = previousStableBaseCDPSnapshot.totalCollateral;
      const newTotalCollateral = newStableBaseCDPSnapshot.totalCollateral;
      const collateralAmount = previousStableBaseCDPSnapshot.safes[safeId].collateralAmount;
      expect(previousTotalCollateral - newTotalCollateral).to.equal(collateralAmount, "Contract's `totalCollateral` should be decreased by the amount of collateral that was in the closed Safe.");
    } else {
      context.logger.warn("totalCollateral snapshots or safe data missing, cannot validate totalCollateral.");
    }


    const zeroAddress = ethers.ZeroAddress;
    if (newStableBaseCDPSnapshot && newStableBaseCDPSnapshot.ownerOf) {
      expect(newStableBaseCDPSnapshot.ownerOf[safeId]).to.equal(zeroAddress, "The NFT representing the Safe (tokenId == safeId) should no longer exist (ownerOf(safeId) == address(0)).");
    } else {
      context.logger.warn("ownerOf snapshot missing, cannot validate NFT ownership.");
    }

    // Validate ERC721 balance
    const previousERC721Balance = previousStableBaseCDPSnapshot?.balanceOf?.[actor.account.address] || BigInt(0);
    const newERC721Balance = newStableBaseCDPSnapshot?.balanceOf?.[actor.account.address] || BigInt(0);

    expect(previousERC721Balance - newERC721Balance).to.equal(BigInt(1), "The balance of the original owner should be decremented by 1.");

    // Validate token approval is cleared
    if (newStableBaseCDPSnapshot && newStableBaseCDPSnapshot.getApproved) {
      expect(newStableBaseCDPSnapshot.getApproved[safeId]).to.equal(ethers.ZeroAddress, "No approvals should exist for the token id `safeId`.");
    } else {
      context.logger.warn("getApproved snapshot missing, cannot validate token approval.");
    }

    // Additional checks can be added for events if needed

    return true;
  }
}
