import { ethers } from "hardhat";
import * as DFIDTokenArtifact from '../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json';
import * as DFIREStakingArtifact from '../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json';
import * as DFIRETokenArtifact from '../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json';
import * as MockPriceOracleArtifact from '../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json';
import * as OrderedDoublyLinkedListArtifact from '../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json';
import * as StabilityPoolArtifact from '../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json';
import * as StableBaseCDPArtifact from '../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json';


export async function deployContracts() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());

  let dfidToken, dfireToken, dfireStaking, stabilityPool, stableBaseCDP, safesOrderedForLiquidation, safesOrderedForRedemption, mockPriceOracle;

  try {
    // Deploy DFIDToken
    const DFIDToken = new ethers.ContractFactory(
      DFIDTokenArtifact.abi,
      DFIDTokenArtifact.bytecode,
      deployer
    );
    dfidToken = await DFIDToken.deploy();
    await dfidToken.waitForDeployment();
    console.log("DFIDToken address:", dfidToken.target);

    // Deploy DFIREToken
    const DFIREToken = new ethers.ContractFactory(
      DFIRETokenArtifact.abi,
      DFIRETokenArtifact.bytecode,
      deployer
    );
    dfireToken = await DFIREToken.deploy();
    await dfireToken.waitForDeployment();
    console.log("DFIREToken address:", dfireToken.target);

    // Deploy DFIREStaking
    const DFIREStaking = new ethers.ContractFactory(
      DFIREStakingArtifact.abi,
      DFIREStakingArtifact.bytecode,
      deployer
    );
    dfireStaking = await DFIREStaking.deploy(true);
    await dfireStaking.waitForDeployment();
    console.log("DFIREStaking address:", dfireStaking.target);

    // Deploy StabilityPool
    const StabilityPool = new ethers.ContractFactory(
      StabilityPoolArtifact.abi,
      StabilityPoolArtifact.bytecode,
      deployer
    );
    stabilityPool = await StabilityPool.deploy(true);
    await stabilityPool.waitForDeployment();
    console.log("StabilityPool address:", stabilityPool.target);

    // Deploy StableBaseCDP
    const StableBaseCDP = new ethers.ContractFactory(
      StableBaseCDPArtifact.abi,
      StableBaseCDPArtifact.bytecode,
      deployer
    );
    stableBaseCDP = await StableBaseCDP.deploy();
    await stableBaseCDP.waitForDeployment();
    console.log("StableBaseCDP address:", stableBaseCDP.target);

    // Deploy OrderedDoublyLinkedList for Liquidation
    const OrderedDoublyLinkedListLiquidation = new ethers.ContractFactory(
      OrderedDoublyLinkedListArtifact.abi,
      OrderedDoublyLinkedListArtifact.bytecode,
      deployer
    );
    safesOrderedForLiquidation = await OrderedDoublyLinkedListLiquidation.deploy();
    await safesOrderedForLiquidation.waitForDeployment();
    console.log("SafesOrderedForLiquidation address:", safesOrderedForLiquidation.target);

    // Deploy OrderedDoublyLinkedList for Redemption
    const OrderedDoublyLinkedListRedemption = new ethers.ContractFactory(
      OrderedDoublyLinkedListArtifact.abi,
      OrderedDoublyLinkedListArtifact.bytecode,
      deployer
    );
    safesOrderedForRedemption = await OrderedDoublyLinkedListRedemption.deploy();
    await safesOrderedForRedemption.waitForDeployment();
    console.log("SafesOrderedForRedemption address:", safesOrderedForRedemption.target);

    // Deploy MockPriceOracle
    const MockPriceOracle = new ethers.ContractFactory(
      MockPriceOracleArtifact.abi,
      MockPriceOracleArtifact.bytecode,
      deployer
    );
    mockPriceOracle = await MockPriceOracle.deploy();
    await mockPriceOracle.waitForDeployment();
    console.log("MockPriceOracle address:", mockPriceOracle.target);

    // Set Addresses
    let tx = await dfidToken.setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("DFIDToken setAddresses done");

    tx = await dfireToken.setAddresses(stabilityPool.target);
    await tx.wait();
    console.log("DFIREToken setAddresses done");

    tx = await dfireStaking.setAddresses(dfireToken.target, dfidToken.target, stableBaseCDP.target);
    await tx.wait();
    console.log("DFIREStaking setAddresses done");

    tx = await stabilityPool.setAddresses(dfidToken.target, stableBaseCDP.target, dfireToken.target);
    await tx.wait();
    console.log("StabilityPool setAddresses done");

    tx = await stableBaseCDP.setAddresses(
      dfidToken.target,
      mockPriceOracle.target,
      stabilityPool.target,
      dfireStaking.target,
      safesOrderedForLiquidation.target,
      safesOrderedForRedemption.target
    );
    await tx.wait();
    console.log("StableBaseCDP setAddresses done");

    tx = await safesOrderedForLiquidation.setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("safesOrderedForLiquidation setAddresses done");

    tx = await safesOrderedForRedemption.setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("safesOrderedForRedemption setAddresses done");

  } catch (error) {
      console.error("Error during deployment or configuration:", error);
      throw error;
  }

  return {
    dfidToken,
    dfireToken,
    dfireStaking,
    stabilityPool,
    stableBaseCDP,
    safesOrderedForLiquidation,
    safesOrderedForRedemption,
    mockPriceOracle
  };
}

export { deployContracts };