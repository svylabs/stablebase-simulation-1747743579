import { ethers } from "hardhat";
import DFIDTokenArtifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import DFIREStakingArtifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import DFIRETokenArtifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import MockPriceOracleArtifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";
import OrderedDoublyLinkedListArtifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import StabilityPoolArtifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import StableBaseCDPArtifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";

async function deployContracts(): Promise<{
  [key: string]: ethers.Contract;
}> {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  const contracts: { [key: string]: ethers.Contract } = {};

  // Deploy DFIDToken
  try {
    const DFIDToken = await ethers.getContractFactoryFromArtifact(
      DFIDTokenArtifact,
      deployer
    );
    const dfidToken = await DFIDToken.deploy();
    await dfidToken.waitForDeployment();
    contracts["dfidToken"] = dfidToken;
    console.log("DFIDToken deployed to:", dfidToken.target);
  } catch (error) {
    console.error("Error deploying DFIDToken:", error);
    throw error;
  }

  // Deploy DFIREToken
  try {
    const DFIREToken = await ethers.getContractFactoryFromArtifact(
      DFIRETokenArtifact,
      deployer
    );
    const dfireToken = await DFIREToken.deploy();
    await dfireToken.waitForDeployment();
    contracts["dfireToken"] = dfireToken;
    console.log("DFIREToken deployed to:", dfireToken.target);
  } catch (error) {
    console.error("Error deploying DFIREToken:", error);
    throw error;
  }

  // Deploy DFIREStaking
  try {
    const DFIREStaking = await ethers.getContractFactoryFromArtifact(
      DFIREStakingArtifact,
      deployer
    );
    const dfireStaking = await DFIREStaking.deploy(true);
    await dfireStaking.waitForDeployment();
    contracts["dfireStaking"] = dfireStaking;
    console.log("DFIREStaking deployed to:", dfireStaking.target);
  } catch (error) {
    console.error("Error deploying DFIREStaking:", error);
    throw error;
  }

  // Deploy StabilityPool
  try {
    const StabilityPool = await ethers.getContractFactoryFromArtifact(
      StabilityPoolArtifact,
      deployer
    );
    const stabilityPool = await StabilityPool.deploy(true);
    await stabilityPool.waitForDeployment();
    contracts["stabilityPool"] = stabilityPool;
    console.log("StabilityPool deployed to:", stabilityPool.target);
  } catch (error) {
    console.error("Error deploying StabilityPool:", error);
    throw error;
  }

  // Deploy StableBaseCDP
  try {
    const StableBaseCDP = await ethers.getContractFactoryFromArtifact(
      StableBaseCDPArtifact,
      deployer
    );
    const stableBaseCDP = await StableBaseCDP.deploy();
    await stableBaseCDP.waitForDeployment();
    contracts["stableBaseCDP"] = stableBaseCDP;
    console.log("StableBaseCDP deployed to:", stableBaseCDP.target);
  } catch (error) {
    console.error("Error deploying StableBaseCDP:", error);
    throw error;
  }

  // Deploy OrderedDoublyLinkedList for Liquidation
  try {
    const OrderedDoublyLinkedListLiquidation = await ethers.getContractFactoryFromArtifact(
      OrderedDoublyLinkedListArtifact,
      deployer
    );
    const safesOrderedForLiquidation = await OrderedDoublyLinkedListLiquidation.deploy();
    await safesOrderedForLiquidation.waitForDeployment();
    contracts["safesOrderedForLiquidation"] = safesOrderedForLiquidation;
    console.log("safesOrderedForLiquidation deployed to:", safesOrderedForLiquidation.target);
  } catch (error) {
    console.error("Error deploying OrderedDoublyLinkedList (Liquidation):", error);
    throw error;
  }

  // Deploy OrderedDoublyLinkedList for Redemption
  try {
    const OrderedDoublyLinkedListRedemption = await ethers.getContractFactoryFromArtifact(
      OrderedDoublyLinkedListArtifact,
      deployer
    );
    const safesOrderedForRedemption = await OrderedDoublyLinkedListRedemption.deploy();
    await safesOrderedForRedemption.waitForDeployment();
    contracts["safesOrderedForRedemption"] = safesOrderedForRedemption;
    console.log("safesOrderedForRedemption deployed to:", safesOrderedForRedemption.target);
  } catch (error) {
    console.error("Error deploying OrderedDoublyLinkedList (Redemption):", error);
    throw error;
  }

  // Deploy MockPriceOracle
  try {
    const MockPriceOracle = await ethers.getContractFactoryFromArtifact(
      MockPriceOracleArtifact,
      deployer
    );
    const mockPriceOracle = await MockPriceOracle.deploy();
    await mockPriceOracle.waitForDeployment();
    contracts["mockPriceOracle"] = mockPriceOracle;
    console.log("MockPriceOracle deployed to:", mockPriceOracle.target);
  } catch (error) {
    console.error("Error deploying MockPriceOracle:", error);
    throw error;
  }

  // Set Addresses - DFIDToken
  try {
    let tx = await dfidToken.connect(deployer).setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("DFIDToken setAddresses completed");
  } catch (error) {
    console.error("Error setting addresses for DFIDToken:", error);
    throw error;
  }

  // Set Addresses - DFIREToken
  try {
    let tx = await dfireToken.connect(deployer).setAddresses(stabilityPool.target);
    await tx.wait();
    console.log("DFIREToken setAddresses completed");
  } catch (error) {
    console.error("Error setting addresses for DFIREToken:", error);
    throw error;
  }

  // Set Addresses - DFIREStaking
  try {
    let tx = await dfireStaking
      .connect(deployer)
      .setAddresses(dfireToken.target, dfidToken.target, stableBaseCDP.target);
    await tx.wait();
    console.log("DFIREStaking setAddresses completed");
  } catch (error) {
    console.error("Error setting addresses for DFIREStaking:", error);
    throw error;
  }

  // Set Addresses - StabilityPool
  try {
    let tx = await stabilityPool
      .connect(deployer)
      .setAddresses(dfidToken.target, stableBaseCDP.target, dfireToken.target);
    await tx.wait();
    console.log("StabilityPool setAddresses completed");
  } catch (error) {
    console.error("Error setting addresses for StabilityPool:", error);
    throw error;
  }

  // Set Addresses - StableBaseCDP
  try {
    let tx = await stableBaseCDP
      .connect(deployer)
      .setAddresses(
        dfidToken.target,
        mockPriceOracle.target,
        stabilityPool.target,
        dfireStaking.target,
        safesOrderedForLiquidation.target,
        safesOrderedForRedemption.target
      );
    await tx.wait();
    console.log("StableBaseCDP setAddresses completed");
  } catch (error) {
    console.error("Error setting addresses for StableBaseCDP:", error);
    throw error;
  }

  // Set Addresses - safesOrderedForLiquidation
  try {
    let tx = await safesOrderedForLiquidation.connect(deployer).setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("safesOrderedForLiquidation setAddresses completed");
  } catch (error) {
    console.error("Error setting addresses for safesOrderedForLiquidation:", error);
    throw error;
  }

  // Set Addresses - safesOrderedForRedemption
  try {
    let tx = await safesOrderedForRedemption.connect(deployer).setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("safesOrderedForRedemption setAddresses completed");
  } catch (error) {
    console.error("Error setting addresses for safesOrderedForRedemption:", error);
    throw error;
  }

  return contracts;
}

export default deployContracts;
