import { ethers } from "hardhat";

// Import contract artifacts
import DFIDTokenArtifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import DFIREStakingArtifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import DFIRETokenArtifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import MockPriceOracleArtifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";
import OrderedDoublyLinkedListArtifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import StabilityPoolArtifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import StableBaseCDPArtifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";

interface ContractDeployments {
  [key: string]: any; // Represents a contract instance
}

export async function deployContracts(): Promise<ContractDeployments> {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);

  const contracts: ContractDeployments = {};

  try {
    // Deploy contracts
    const DFIDTokenFactory = new ethers.ContractFactory(
      DFIDTokenArtifact.abi,
      DFIDTokenArtifact.bytecode,
      deployer
    );
    const DFIRETokenFactory = new ethers.ContractFactory(
      DFIRETokenArtifact.abi,
      DFIRETokenArtifact.bytecode,
      deployer
    );
    const DFIREStakingFactory = new ethers.ContractFactory(
      DFIREStakingArtifact.abi,
      DFIREStakingArtifact.bytecode,
      deployer
    );
    const StabilityPoolFactory = new ethers.ContractFactory(
      StabilityPoolArtifact.abi,
      StabilityPoolArtifact.bytecode,
      deployer
    );
    const StableBaseCDPFactory = new ethers.ContractFactory(
      StableBaseCDPArtifact.abi,
      StableBaseCDPArtifact.bytecode,
      deployer
    );
    const OrderedDoublyLinkedListFactory = new ethers.ContractFactory(
      OrderedDoublyLinkedListArtifact.abi,
      OrderedDoublyLinkedListArtifact.bytecode,
      deployer
    );
    const MockPriceOracleFactory = new ethers.ContractFactory(
      MockPriceOracleArtifact.abi,
      MockPriceOracleArtifact.bytecode,
      deployer
    );

    const dfidToken = await DFIDTokenFactory.deploy();
    await dfidToken.waitForDeployment();
    contracts['dfidToken'] = dfidToken.target;

    const dfireToken = await DFIRETokenFactory.deploy();
    await dfireToken.waitForDeployment();
    contracts['dfireToken'] = dfireToken.target;

    const dfireStaking = await DFIREStakingFactory.deploy(true);
    await dfireStaking.waitForDeployment();
    contracts['dfireStaking'] = dfireStaking.target;

    const stabilityPool = await StabilityPoolFactory.deploy(true);
    await stabilityPool.waitForDeployment();
    contracts['stabilityPool'] = stabilityPool.target;

    const stableBaseCDP = await StableBaseCDPFactory.deploy();
    await stableBaseCDP.waitForDeployment();
    contracts['stableBaseCDP'] = stableBaseCDP.target;

    const safesOrderedForLiquidation = await OrderedDoublyLinkedListFactory.deploy();
    await safesOrderedForLiquidation.waitForDeployment();
    contracts['safesOrderedForLiquidation'] = safesOrderedForLiquidation.target;

    const safesOrderedForRedemption = await OrderedDoublyLinkedListFactory.deploy();
    await safesOrderedForRedemption.waitForDeployment();
    contracts['safesOrderedForRedemption'] = safesOrderedForRedemption.target;

    const mockPriceOracle = await MockPriceOracleFactory.deploy();
    await mockPriceOracle.waitForDeployment();
    contracts['mockPriceOracle'] = mockPriceOracle.target;

    console.log("Contracts deployed");

    // Call setAddresses functions
    let tx = await dfidToken.setAddresses(stableBaseCDP.target);
    await tx.wait();

    tx = await dfireStaking.setAddresses(
      dfireToken.target,
      dfidToken.target,
      stableBaseCDP.target
    );
    await tx.wait();

    tx = await stabilityPool.setAddresses(
      dfidToken.target,
      stableBaseCDP.target,
      dfireToken.target
    );
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

    console.log("setAddress calls complete");

    return contracts;
  } catch (error: any) {
    console.error("Error during deployment or setup:", error);
    throw error; // Re-throw the error to indicate failure
  }
}
