import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import DFIDTokenArtifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import DFIREStakingArtifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import DFIRETokenArtifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import MockPriceOracleArtifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";
import OrderedDoublyLinkedListArtifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import StabilityPoolArtifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import StableBaseCDPArtifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";


async function deployContracts(): Promise<{
  [key: string]: Contract;
}> {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  const DFIDToken = await ethers.getContractFactoryFromArtifact(DFIDTokenArtifact);
  const dfidToken = await DFIDToken.deploy();
  await dfidToken.waitForDeployment();

  const DFIREToken = await ethers.getContractFactoryFromArtifact(DFIRETokenArtifact);
  const dfireToken = await DFIREToken.deploy();
  await dfireToken.waitForDeployment();

  const DFIREStaking = await ethers.getContractFactoryFromArtifact(DFIREStakingArtifact);
  const dfireStaking = await DFIREStaking.deploy(true);
  await dfireStaking.waitForDeployment();

  const StabilityPool = await ethers.getContractFactoryFromArtifact(StabilityPoolArtifact);
  const stabilityPool = await StabilityPool.deploy(true);
  await stabilityPool.waitForDeployment();

  const StableBaseCDP = await ethers.getContractFactoryFromArtifact(StableBaseCDPArtifact);
  const stableBaseCDP = await StableBaseCDP.deploy();
  await stableBaseCDP.waitForDeployment();

  const OrderedDoublyLinkedList = await ethers.getContractFactoryFromArtifact(OrderedDoublyLinkedListArtifact);
  const safesOrderedForLiquidation = await OrderedDoublyLinkedList.deploy();
  await safesOrderedForLiquidation.waitForDeployment();

  const safesOrderedForRedemption = await OrderedDoublyLinkedList.deploy();
  await safesOrderedForRedemption.waitForDeployment();

  const MockPriceOracle = await ethers.getContractFactoryFromArtifact(MockPriceOracleArtifact);
  const mockPriceOracle = await MockPriceOracle.deploy();
  await mockPriceOracle.waitForDeployment();

  // Set Addresses
  let tx = await dfidToken.setAddresses(stableBaseCDP.target);
  await tx.wait();

  tx = await dfireToken.setAddresses(stabilityPool.target);
  await tx.wait();

  tx = await dfireStaking.setAddresses(dfireToken.target, dfidToken.target, stableBaseCDP.target);
  await tx.wait();

  tx = await stabilityPool.setAddresses(dfidToken.target, stableBaseCDP.target, dfireToken.target);
  await tx.wait();

  tx = await stableBaseCDP.setAddresses(
      dfidToken.target,
      mockPriceOracle.target,
      stabilityPool.target,
      dfireStaking.target,
      safesOrderedForLiquidation.target,
      safesOrderedForRedemption.target
  );
  await tx.wait();

  tx = await safesOrderedForLiquidation.setAddresses(stableBaseCDP.target);
  await tx.wait();

  tx = await safesOrderedForRedemption.setAddresses(stableBaseCDP.target);
  await tx.wait();


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