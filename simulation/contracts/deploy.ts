import { ethers } from "hardhat";
import * as DFIDTokenArtifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import * as DFIREStakingArtifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import * as DFIRETokenArtifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import * as MockPriceOracleArtifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";
import * as OrderedDoublyLinkedListArtifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import * as StabilityPoolArtifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import * as StableBaseCDPArtifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";

async function deployContracts() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  const dfidToken = await (await ethers.getContractFactory(
    DFIDTokenArtifact.abi,
    DFIDTokenArtifact.bytecode,
    deployer
  )).deploy();
  await dfidToken.waitForDeployment();
  console.log("DFIDToken deployed to:", dfidToken.target);

  const dfireToken = await (await ethers.getContractFactory(
    DFIRETokenArtifact.abi,
    DFIRETokenArtifact.bytecode,
    deployer
  )).deploy();
  await dfireToken.waitForDeployment();
  console.log("DFIREToken deployed to:", dfireToken.target);

  const dfireStaking = await (await ethers.getContractFactory(
    DFIREStakingArtifact.abi,
    DFIREStakingArtifact.bytecode,
    deployer
  )).deploy(true);
  await dfireStaking.waitForDeployment();
  console.log("DFIREStaking deployed to:", dfireStaking.target);

  const stabilityPool = await (await ethers.getContractFactory(
    StabilityPoolArtifact.abi,
    StabilityPoolArtifact.bytecode,
    deployer
  )).deploy(true);
  await stabilityPool.waitForDeployment();
  console.log("StabilityPool deployed to:", stabilityPool.target);

  const stableBaseCDP = await (await ethers.getContractFactory(
    StableBaseCDPArtifact.abi,
    StableBaseCDPArtifact.bytecode,
    deployer
  )).deploy();
  await stableBaseCDP.waitForDeployment();
  console.log("StableBaseCDP deployed to:", stableBaseCDP.target);

  const safesOrderedForLiquidation = await (await ethers.getContractFactory(
    OrderedDoublyLinkedListArtifact.abi,
    OrderedDoublyLinkedListArtifact.bytecode,
    deployer
  )).deploy();
  await safesOrderedForLiquidation.waitForDeployment();
  console.log("safesOrderedForLiquidation deployed to:", safesOrderedForLiquidation.target);

  const safesOrderedForRedemption = await (await ethers.getContractFactory(
    OrderedDoublyLinkedListArtifact.abi,
    OrderedDoublyLinkedListArtifact.bytecode,
    deployer
  )).deploy();
  await safesOrderedForRedemption.waitForDeployment();
  console.log("safesOrderedForRedemption deployed to:", safesOrderedForRedemption.target);

  const mockPriceOracle = await (await ethers.getContractFactory(
    MockPriceOracleArtifact.abi,
    MockPriceOracleArtifact.bytecode,
    deployer
  )).deploy();
  await mockPriceOracle.waitForDeployment();
  console.log("MockPriceOracle deployed to:", mockPriceOracle.target);

  // Set Addresses
  await (await dfireStaking.connect(deployer).setAddresses(dfireToken.target, dfidToken.target, stableBaseCDP.target)).wait();
  console.log("DFIREStaking setAddresses");

  await (await stabilityPool.connect(deployer).setAddresses(dfidToken.target, stableBaseCDP.target, dfireToken.target)).wait();
  console.log("StabilityPool setAddresses");

  await (await stableBaseCDP.connect(deployer).setAddresses(
    dfidToken.target,
    mockPriceOracle.target,
    stabilityPool.target,
    dfireStaking.target,
    safesOrderedForLiquidation.target,
    safesOrderedForRedemption.target
  )).wait();
  console.log("StableBaseCDP setAddresses");

  await (await safesOrderedForLiquidation.connect(deployer).setAddresses(stableBaseCDP.target)).wait();
  console.log("safesOrderedForLiquidation setAddresses");

  await (await safesOrderedForRedemption.connect(deployer).setAddresses(stableBaseCDP.target)).wait();
  console.log("safesOrderedForRedemption setAddresses");

  return {
    dfidToken,
    dfireToken,
    dfireStaking,
    stabilityPool,
    stableBaseCDP,
    safesOrderedForLiquidation,
    safesOrderedForRedemption,
    mockPriceOracle,
  };
}

export { deployContracts };