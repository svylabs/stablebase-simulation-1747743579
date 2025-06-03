import { ethers } from "ethers";

class StableBaseCDPOpensafeAction {
  async initialize(
    context: any,
    actor: any,
    currentSnapshot: any
  ): Promise<[any, Record<string, any>]> {
    // Generate random collateral amount
    const collateralAmount = BigInt(context.prng.next() % 10000);

    // Return parameters for the openSafe function
    const params = [collateralAmount];

    // Return any additional data you want to use in the execute or validate methods
    const additionalData = {};

    return [params, additionalData];
  }

  async execute(
    context: any,
    actor: any,
    currentSnapshot: any,
    actionParams: any
  ): Promise<Record<string, any> | void> {
    const stableBaseCDPAddress = context.addresses.StableBaseCDP;
    if (!context.abis.StableBaseCDP) {
      throw new Error("StableBaseCDP ABI not found in context.");
    }
    const stableBaseCDP = new ethers.Contract(
      stableBaseCDPAddress,
      context.abis.StableBaseCDP,
      actor.account.value
    );

    const tx = await stableBaseCDP.openSafe(...actionParams);
    await tx.wait();
  }

  async validate(
    context: any,
    actor: any,
    previousSnapshot: any,
    newSnapshot: any,
    actionParams: any
  ): Promise<boolean> {
    const collateralAmount = actionParams[0];
    const actorAddress = actor.account.address;

    // Get the safe ID assigned to the actor
    const safeId = actor.identifiers.getIdentifiers('StableBaseCDP')?._safeId;

    // Validate that the safe is created and collateral amount is set correctly
    if (!safeId) {
      console.log("Safe ID not found for actor.");
      return false;
    }

    if (!newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId]) {
      console.log("Safe not initialized in new snapshot.");
      return false;
    }

    if (
      newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId]
        .collateralAmount !== collateralAmount
    ) {
      console.log(
        `Collateral amount mismatch. Expected ${collateralAmount}, got ${newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId].collateralAmount}`
      );
      return false;
    }

    if (newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId].borrowedAmount !== BigInt(0)) {
        console.log(`Borrowed amount should be 0, got ${newSnapshot.contractSnapshot.stableBaseCDP.safes[safeId].borrowedAmount}`);
        return false;
    }

    // Validate total collateral increased
    const previousTotalCollateral = previousSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0);
    const newTotalCollateral = newSnapshot.contractSnapshot.stableBaseCDP.totalCollateral || BigInt(0);

    if (newTotalCollateral - previousTotalCollateral !== collateralAmount) {
      console.log(
        `Total collateral mismatch. Expected increase of ${collateralAmount}, got ${newTotalCollateral - previousTotalCollateral}`
      );
      return false;
    }
    
    // Validate NFT ownership
    if(newSnapshot.contractSnapshot.stableBaseCDP.owners[safeId] !== actorAddress){
        console.log(`Owner of the safe is not the actor, expected ${actorAddress} got ${newSnapshot.contractSnapshot.stableBaseCDP.owners[safeId]}`);
        return false;
    }

    return true;
  }
}

export default StableBaseCDPOpensafeAction;
