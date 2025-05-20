import { ethers } from "hardhat";

// Import contract artifacts
import DFIDToken_artifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import DFIREStaking_artifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import DFIREToken_artifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import MockPriceOracle_artifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";
import OrderedDoublyLinkedList_artifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import StabilityPool_artifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import StableBaseCDP_artifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";

export async function deployContracts() {
  // Get the deployer account
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  const deployedContracts: { [key: string]: any } = {};

  // Deploy contracts in sequence
  // Contract deployment
  try {
    const DFIDTokenFactory = new ethers.ContractFactory(
      DFIDToken_artifact.abi,
      DFIDToken_artifact.bytecode,
      deployer
    );
    const dfidToken = await DFIDTokenFactory.deploy();
    await dfidToken.waitForDeployment();
    deployedContracts["dfidToken"] = dfidToken;
    console.log("DFIDToken deployed to:", dfidToken.target);
  } catch (error) {
    console.error("Error deploying DFIDToken:", error);
    throw error; // Re-throw the error to halt the deployment
  }

  try {
    const DFIRETokenFactory = new ethers.ContractFactory(
      DFIREToken_artifact.abi,
      DFIREToken_artifact.bytecode,
      deployer
    );
    const dfireToken = await DFIRETokenFactory.deploy();
    await dfireToken.waitForDeployment();
    deployedContracts["dfireToken"] = dfireToken;
    console.log("DFIREToken deployed to:", dfireToken.target);
  } catch (error) {
    console.error("Error deploying DFIREToken:", error);
    throw error;
  }

  try {
    const DFIREStakingFactory = new ethers.ContractFactory(
      DFIREStaking_artifact.abi,
      DFIREStaking_artifact.bytecode,
      deployer
    );
    const dfireStaking = await DFIREStakingFactory.deploy(true);
    await dfireStaking.waitForDeployment();
    deployedContracts["dfireStaking"] = dfireStaking;
    console.log("DFIREStaking deployed to:", dfireStaking.target, "with _rewardSenderActive = true");
  } catch (error) {
    console.error("Error deploying DFIREStaking:", error);
    throw error;
  }

  try {
    const StabilityPoolFactory = new ethers.ContractFactory(
      StabilityPool_artifact.abi,
      StabilityPool_artifact.bytecode,
      deployer
    );
    const stabilityPool = await StabilityPoolFactory.deploy(true);
    await stabilityPool.waitForDeployment();
    deployedContracts["stabilityPool"] = stabilityPool;
    console.log("StabilityPool deployed to:", stabilityPool.target, "with _rewardSenderActive = true");
  } catch (error) {
    console.error("Error deploying StabilityPool:", error);
    throw error;
  }

  try {
    const StableBaseCDPFactory = new ethers.ContractFactory(
      StableBaseCDP_artifact.abi,
      StableBaseCDP_artifact.bytecode,
      deployer
    );
    const stableBaseCDP = await StableBaseCDPFactory.deploy();
    await stableBaseCDP.waitForDeployment();
    deployedContracts["stableBaseCDP"] = stableBaseCDP;
    console.log("StableBaseCDP deployed to:", stableBaseCDP.target);
  } catch (error) {
    console.error("Error deploying StableBaseCDP:", error);
    throw error;
  }

  try {
    const OrderedDoublyLinkedListFactory = new ethers.ContractFactory(
      OrderedDoublyLinkedList_artifact.abi,
      OrderedDoublyLinkedList_artifact.bytecode,
      deployer
    );
    const safesOrderedForLiquidation = await OrderedDoublyLinkedListFactory.deploy();
    await safesOrderedForLiquidation.waitForDeployment();
    deployedContracts["safesOrderedForLiquidation"] = safesOrderedForLiquidation;
    console.log("SafesOrderedForLiquidation deployed to:", safesOrderedForLiquidation.target);
  } catch (error) {
    console.error("Error deploying SafesOrderedForLiquidation:", error);
    throw error;
  }

  try {
    const OrderedDoublyLinkedListFactory = new ethers.ContractFactory(
      OrderedDoublyLinkedList_artifact.abi,
      OrderedDoublyLinkedList_artifact.bytecode,
      deployer
    );
    const safesOrderedForRedemption = await OrderedDoublyLinkedListFactory.deploy();
    await safesOrderedForRedemption.waitForDeployment();
    deployedContracts["safesOrderedForRedemption"] = safesOrderedForRedemption;
    console.log("SafesOrderedForRedemption deployed to:", safesOrderedForRedemption.target);
  } catch (error) {
    console.error("Error deploying SafesOrderedForRedemption:", error);
    throw error;
  }

  try {
    const MockPriceOracleFactory = new ethers.ContractFactory(
      MockPriceOracle_artifact.abi,
      MockPriceOracle_artifact.bytecode,
      deployer
    );
    const mockPriceOracle = await MockPriceOracleFactory.deploy();
    await mockPriceOracle.waitForDeployment();
    deployedContracts["mockPriceOracle"] = mockPriceOracle;
    console.log("MockPriceOracle deployed to:", mockPriceOracle.target);
  } catch (error) {
    console.error("Error deploying MockPriceOracle:", error);
    throw error;
  }

  // Contract calls
  try {
    let tx = await deployedContracts["dfidToken"].setAddresses(deployedContracts["stableBaseCDP"].target);
    await tx.wait();
    console.log("DFIDToken.setAddresses called with _stableBaseCDP:", deployedContracts["stableBaseCDP"].target);
  } catch (error) {
    console.error("Error calling DFIDToken.setAddresses:", error);
    throw error;
  }

  try {
    let tx = await deployedContracts["dfireToken"].setAddresses(deployedContracts["stabilityPool"].target);
    await tx.wait();
    console.log("DFIREToken.setAddresses called with _stabilityPool:", deployedContracts["stabilityPool"].target);
  } catch (error) {
    console.error("Error calling DFIREToken.setAddresses:", error);
    throw error;
  }

  try {
    let tx = await deployedContracts["dfireStaking"].setAddresses(
      deployedContracts["dfireToken"].target,
      deployedContracts["dfidToken"].target,
      deployedContracts["stableBaseCDP"].target
    );
    await tx.wait();
    console.log("DFIREStaking.setAddresses called with _stakingToken:", deployedContracts["dfireToken"].target, "_rewardToken:", deployedContracts["dfidToken"].target, "_stableBaseContract:", deployedContracts["stableBaseCDP"].target);
  } catch (error) {
    console.error("Error calling DFIREStaking.setAddresses:", error);
    throw error;
  }

  try {
    let tx = await deployedContracts["stabilityPool"].setAddresses(
      deployedContracts["dfidToken"].target,
      deployedContracts["stableBaseCDP"].target,
      deployedContracts["dfireToken"].target
    );
    await tx.wait();
    console.log("StabilityPool.setAddresses called with _stakingToken:", deployedContracts["dfidToken"].target, "_stableBaseCDP:", deployedContracts["stableBaseCDP"].target, "_sbrToken:", deployedContracts["dfireToken"].target);
  } catch (error) {
    console.error("Error calling StabilityPool.setAddresses:", error);
    throw error;
  }

  try {
    let tx = await deployedContracts["stableBaseCDP"].setAddresses(
      deployedContracts["dfidToken"].target,
      deployedContracts["mockPriceOracle"].target,
      deployedContracts["stabilityPool"].target,
      deployedContracts["dfireStaking"].target,
      deployedContracts["safesOrderedForLiquidation"].target,
      deployedContracts["safesOrderedForRedemption"].target
    );
    await tx.wait();
    console.log("StableBaseCDP.setAddresses called with _sbdToken:", deployedContracts["dfidToken"].target, "_priceOracle:", deployedContracts["mockPriceOracle"].target, "_stabilityPool:", deployedContracts["stabilityPool"].target, "_dfireTokenStaking:", deployedContracts["dfireStaking"].target, "_safesOrderedForLiquidation:", deployedContracts["safesOrderedForLiquidation"].target, "_safesOrderedForRedemption:", deployedContracts["safesOrderedForRedemption"].target);
  } catch (error) {
    console.error("Error calling StableBaseCDP.setAddresses:", error);
    throw error;
  }

  try {
    let tx = await deployedContracts["safesOrderedForLiquidation"].setAddresses(deployedContracts["stableBaseCDP"].target);
    await tx.wait();
    console.log("SafesOrderedForLiquidation.setAddresses called with _stableBaseCDP:", deployedContracts["stableBaseCDP"].target);
  } catch (error) {
    console.error("Error calling SafesOrderedForLiquidation.setAddresses:", error);
    throw error;
  }

  try {
    let tx = await deployedContracts["safesOrderedForRedemption"].setAddresses(deployedContracts["stableBaseCDP"].target);
    await tx.wait();
    console.log("SafesOrderedForRedemption.setAddresses called with _stableBaseCDP:", deployedContracts["stableBaseCDP"].target);
  } catch (error) {
    console.error("Error calling SafesOrderedForRedemption.setAddresses:", error);
    throw error;
  }

  return deployedContracts;
}
