import { ethers } from "hardhat";

// Import contract artifacts
import DFIDTokenArtifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import DFIREStakingArtifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import DFIRETokenArtifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import MockPriceOracleArtifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";
import OrderedDoublyLinkedListArtifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import StabilityPoolArtifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import StableBaseCDPArtifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";

export async function deployContracts() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  const contracts: { [key: string]: any } = {};

  // Deploy DFIDToken
  const DFIDTokenFactory = new ethers.ContractFactory(
    DFIDTokenArtifact.abi,
    DFIDTokenArtifact.bytecode,
    deployer
  );
  contracts['dfidToken'] = await DFIDTokenFactory.deploy();
  await contracts['dfidToken'].waitForDeployment();
  console.log("DFIDToken deployed to:", contracts['dfidToken'].target);

  // Deploy DFIREToken
  const DFIRETokenFactory = new ethers.ContractFactory(
    DFIRETokenArtifact.abi,
    DFIRETokenArtifact.bytecode,
    deployer
  );
  contracts['dfireToken'] = await DFIRETokenFactory.deploy();
  await contracts['dfireToken'].waitForDeployment();
  console.log("DFIREToken deployed to:", contracts['dfireToken'].target);

  // Deploy Staking Token
  contracts['stakingToken'] = await DFIRETokenFactory.deploy();
  await contracts['stakingToken'].waitForDeployment();
  console.log("StakingToken deployed to:", contracts['stakingToken'].target);

  // Deploy Reward Token
  contracts['rewardToken'] = await DFIRETokenFactory.deploy();
  await contracts['rewardToken'].waitForDeployment();
  console.log("RewardToken deployed to:", contracts['rewardToken'].target);

  // Deploy DFIREStaking
  const DFIREStakingFactory = new ethers.ContractFactory(
    DFIREStakingArtifact.abi,
    DFIREStakingArtifact.bytecode,
    deployer
  );
  contracts['dfireStaking'] = await DFIREStakingFactory.deploy(true);
  await contracts['dfireStaking'].waitForDeployment();
  console.log("DFIREStaking deployed to:", contracts['dfireStaking'].target);

  // Deploy StabilityPool
  const StabilityPoolFactory = new ethers.ContractFactory(
    StabilityPoolArtifact.abi,
    StabilityPoolArtifact.bytecode,
    deployer
  );
  contracts['stabilityPool'] = await StabilityPoolFactory.deploy(true);
  await contracts['stabilityPool'].waitForDeployment();
  console.log("StabilityPool deployed to:", contracts['stabilityPool'].target);

  // Deploy StableBaseCDP
  const StableBaseCDPFactory = new ethers.ContractFactory(
    StableBaseCDPArtifact.abi,
    StableBaseCDPArtifact.bytecode,
    deployer
  );
  contracts['stableBaseCDP'] = await StableBaseCDPFactory.deploy();
  await contracts['stableBaseCDP'].waitForDeployment();
  console.log("StableBaseCDP deployed to:", contracts['stableBaseCDP'].target);

  // Deploy SafesOrderedForLiquidation
  const OrderedDoublyLinkedListFactory = new ethers.ContractFactory(
    OrderedDoublyLinkedListArtifact.abi,
    OrderedDoublyLinkedListArtifact.bytecode,
    deployer
  );
  contracts['safesOrderedForLiquidation'] = await OrderedDoublyLinkedListFactory.deploy();
  await contracts['safesOrderedForLiquidation'].waitForDeployment();
  console.log("SafesOrderedForLiquidation deployed to:", contracts['safesOrderedForLiquidation'].target);

  // Deploy SafesOrderedForRedemption
  contracts['safesOrderedForRedemption'] = await OrderedDoublyLinkedListFactory.deploy();
  await contracts['safesOrderedForRedemption'].waitForDeployment();
  console.log("SafesOrderedForRedemption deployed to:", contracts['safesOrderedForRedemption'].target);

  // Deploy MockPriceOracle
  const MockPriceOracleFactory = new ethers.ContractFactory(
    MockPriceOracleArtifact.abi,
    MockPriceOracleArtifact.bytecode,
    deployer
  );
  contracts['mockPriceOracle'] = await MockPriceOracleFactory.deploy();
  await contracts['mockPriceOracle'].waitForDeployment();
  console.log("MockPriceOracle deployed to:", contracts['mockPriceOracle'].target);

  // Call setAddresses functions
  let tx = await contracts['dfireStaking'].setAddresses(
    contracts['stakingToken'].target,
    contracts['rewardToken'].target,
    contracts['stableBaseCDP'].target
  );
  await tx.wait();
  console.log("DFIREStaking setAddresses called");

  tx = await contracts['stabilityPool'].setAddresses(
    contracts['stakingToken'].target,
    contracts['stableBaseCDP'].target,
    contracts['dfireToken'].target
  );
  await tx.wait();
  console.log("StabilityPool setAddresses called");

  tx = await contracts['stableBaseCDP'].setAddresses(
    contracts['dfidToken'].target,
    contracts['mockPriceOracle'].target,
    contracts['stabilityPool'].target,
    contracts['dfireStaking'].target,
    contracts['safesOrderedForLiquidation'].target,
    contracts['safesOrderedForRedemption'].target
  );
  await tx.wait();
  console.log("StableBaseCDP setAddresses called");

  tx = await contracts['safesOrderedForLiquidation'].setAddresses(
    contracts['stableBaseCDP'].target
  );
  await tx.wait();
  console.log("SafesOrderedForLiquidation setAddresses called");

  tx = await contracts['safesOrderedForRedemption'].setAddresses(
    contracts['stableBaseCDP'].target
  );
  await tx.wait();
  console.log("SafesOrderedForRedemption setAddresses called");

  return contracts;
}
