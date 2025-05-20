import { ethers } from "hardhat";
import * as DFIDTokenArtifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import * as DFIRETokenArtifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import * as DFIREStakingArtifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import * as StabilityPoolArtifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import * as StableBaseCDPArtifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";
import * as OrderedDoublyLinkedListArtifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import * as MockPriceOracleArtifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";


async function deployContracts() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  //const balance = await deployer.getBalance();
  //console.log("Account balance:", balance.toString());

  const DFIDToken = new ethers.ContractFactory(
    DFIDTokenArtifact.abi,
    DFIDTokenArtifact.bytecode,
    deployer
  );
  const dfidToken = await DFIDToken.deploy();
  await dfidToken.waitForDeployment();
  console.log("DFIDToken address:", dfidToken.target);

  const DFIREToken = new ethers.ContractFactory(
    DFIRETokenArtifact.abi,
    DFIRETokenArtifact.bytecode,
    deployer
  );
  const dfireToken = await DFIREToken.deploy();
  await dfireToken.waitForDeployment();
  console.log("DFIREToken address:", dfireToken.target);

  const DFIREStaking = new ethers.ContractFactory(
    DFIREStakingArtifact.abi,
    DFIREStakingArtifact.bytecode,
    deployer
  );
  const dfireStaking = await DFIREStaking.deploy(true);
  await dfireStaking.waitForDeployment();
  console.log("DFIREStaking address:", dfireStaking.target);

  const StabilityPool = new ethers.ContractFactory(
    StabilityPoolArtifact.abi,
    StabilityPoolArtifact.bytecode,
    deployer
  );
  const stabilityPool = await StabilityPool.deploy(true);
  await stabilityPool.waitForDeployment();
  console.log("StabilityPool address:", stabilityPool.target);

  const StableBaseCDP = new ethers.ContractFactory(
    StableBaseCDPArtifact.abi,
    StableBaseCDPArtifact.bytecode,
    deployer
  );
  const stableBaseCDP = await StableBaseCDP.deploy();
  await stableBaseCDP.waitForDeployment();
  console.log("StableBaseCDP address:", stableBaseCDP.target);

  const OrderedDoublyLinkedListLiquidation = new ethers.ContractFactory(
    OrderedDoublyLinkedListArtifact.abi,
    OrderedDoublyLinkedListArtifact.bytecode,
    deployer
  );
  const safesOrderedForLiquidation = await OrderedDoublyLinkedListLiquidation.deploy();
  await safesOrderedForLiquidation.waitForDeployment();
  console.log("safesOrderedForLiquidation address:", safesOrderedForLiquidation.target);

  const OrderedDoublyLinkedListRedemption = new ethers.ContractFactory(
    OrderedDoublyLinkedListArtifact.abi,
    OrderedDoublyLinkedListArtifact.bytecode,
    deployer
  );
  const safesOrderedForRedemption = await OrderedDoublyLinkedListRedemption.deploy();
  await safesOrderedForRedemption.waitForDeployment();
  console.log("safesOrderedForRedemption address:", safesOrderedForRedemption.target);

  const MockPriceOracle = new ethers.ContractFactory(
    MockPriceOracleArtifact.abi,
    MockPriceOracleArtifact.bytecode,
    deployer
  );
  const mockPriceOracle = await MockPriceOracle.deploy();
  await mockPriceOracle.waitForDeployment();
  console.log("MockPriceOracle address:", mockPriceOracle.target);

  // Set Addresses
  let tx = await dfidToken.connect(deployer).setAddresses(stableBaseCDP.target);
  await tx.wait();
  console.log("DFIDToken setAddresses done");

  tx = await dfireToken.connect(deployer).setAddresses(stabilityPool.target);
  await tx.wait();
  console.log("DFIREToken setAddresses done");

  tx = await dfireStaking.connect(deployer).setAddresses(dfireToken.target, dfidToken.target, stableBaseCDP.target);
  await tx.wait();
  console.log("DFIREStaking setAddresses done");

  tx = await stabilityPool.connect(deployer).setAddresses(dfidToken.target, stableBaseCDP.target, dfireToken.target);
  await tx.wait();
  console.log("StabilityPool setAddresses done");

  tx = await stableBaseCDP.connect(deployer).setAddresses(
    dfidToken.target,
    mockPriceOracle.target,
    stabilityPool.target,
    dfireStaking.target,
    safesOrderedForLiquidation.target,
    safesOrderedForRedemption.target
  );
  await tx.wait();
  console.log("StableBaseCDP setAddresses done");

  tx = await safesOrderedForLiquidation.connect(deployer).setAddresses(stableBaseCDP.target);
  await tx.wait();
  console.log("safesOrderedForLiquidation setAddresses done");

  tx = await safesOrderedForRedemption.connect(deployer).setAddresses(stableBaseCDP.target);
  await tx.wait();
  console.log("safesOrderedForRedemption setAddresses done");

  return {
    dfidToken: dfidToken,
    dfireToken: dfireToken,
    dfireStaking: dfireStaking,
    stabilityPool: stabilityPool,
    stableBaseCDP: stableBaseCDP,
    safesOrderedForLiquidation: safesOrderedForLiquidation,
    safesOrderedForRedemption: safesOrderedForRedemption,
    mockPriceOracle: mockPriceOracle
  };
}

export default deployContracts;