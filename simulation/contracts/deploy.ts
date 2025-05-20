import { ethers } from "hardhat";
import * as fs from 'fs';

interface DeploymentSequence {
  type: string;
  contract: string;
  constructor: string;
  function: string;
  ref_name: string;
  params: { name: string; value: string; type: string }[];
}

interface DeploymentConfig {
  sequence: DeploymentSequence[];
}

async function deployContracts() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", balance.toString());

  const rawdata = fs.readFileSync('deployment_config.json');
  const deploymentConfig: DeploymentConfig = JSON.parse(rawdata.toString());
  
  // Mapping of artifact import paths for the contracts.
  const artifactPaths = {
    "DFIDToken": "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json",
    "DFIREStaking": "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json",
    "DFIREToken": "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json",
    "MockPriceOracle": "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json",
    "OrderedDoublyLinkedList": "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json",
    "StabilityPool": "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json",
    "StableBaseCDP": "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json"
  };

  const deployedContracts: { [key: string]: any } = {};

  for (const step of deploymentConfig.sequence) {
    if (step.type === "deploy") {
      console.log(`Deploying ${step.contract}...`);
      const artifactPath = artifactPaths[step.contract];
      if (!artifactPath) {
        throw new Error(`Artifact path not found for contract: ${step.contract}`);
      }

      const artifact = await import(artifactPath);
      const ContractFactory = await ethers.getContractFactory(artifact.abi, artifact.bytecode);

      let constructorArgs = [];
      if (step.params && step.params.length > 0) {
        constructorArgs = step.params.map(param => {
          if (param.type === "val") {
            return param.value;
          } else if (param.type === "ref") {
            return deployedContracts[param.value].target; // changed from .address
          }
          return param.value;
        });
      }

      const contract = await ContractFactory.connect(deployer).deploy(...constructorArgs);
      await contract.waitForDeployment();

      console.log(`${step.contract} deployed to:`, contract.target); // changed from .address
      deployedContracts[step.ref_name] = contract;
    }
  }

  for (const step of deploymentConfig.sequence) {
    if (step.type === "call") {
      console.log(`Calling function ${step.function} on ${step.contract}...`);
      const contract = deployedContracts[step.contract];
      if (!contract) {
        throw new Error(`Contract not found: ${step.contract}`);
      }

      let params = [];
      if (step.params && step.params.length > 0) {
        params = step.params.map(param => {
          if (param.type === "val") {
            return param.value;
          } else if (param.type === "ref") {
            return deployedContracts[param.value].target; // changed from .address
          }
          return param.value;
        });
      }

      const tx = await contract.connect(deployer)[step.function](...params);
      await tx.wait();

      console.log(`Transaction confirmed for ${step.function} on ${step.contract}`);
    }
  }

  return deployedContracts;
}



export default deployContracts;
