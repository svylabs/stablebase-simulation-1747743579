import { ethers } from 'hardhat';
import { Contract, ContractFactory } from 'ethers';

// Contract Artifacts
import DFIDTokenArtifact from '../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json';
import DFIREStakingArtifact from '../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json';
import DFIRETokenArtifact from '../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json';
import MockPriceOracleArtifact from '../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json';
import OrderedDoublyLinkedListArtifact from '../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json';
import StabilityPoolArtifact from '../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json';
import StableBaseCDPArtifact from '../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json';

interface DeploymentInstruction {
    sequence: DeploymentStep[];
}

interface DeploymentStep {
    type: string;
    contract: string;
    constructor: string;
    function: string | null;
    ref_name: string;
    params: DeploymentParameter[];
}

interface DeploymentParameter {
    name: string;
    value: string;
    type: string;
}

interface ContractArtifact {
    abi: any;
    bytecode: string;
}

const contractArtifacts: { [contractName: string]: ContractArtifact } = {
    "DFIDToken": DFIDTokenArtifact,
    "DFIREStaking": DFIREStakingArtifact,
    "DFIREToken": DFIRETokenArtifact,
    "MockPriceOracle": MockPriceOracleArtifact,
    "OrderedDoublyLinkedList": OrderedDoublyLinkedListArtifact,
    "StabilityPool": StabilityPoolArtifact,
    "StableBaseCDP": StableBaseCDPArtifact
};

async function deployContract(contractName: string, constructor: string, deployer: any, params: DeploymentParameter[]): Promise<Contract> {
    console.log(`Deploying ${contractName} with constructor ${constructor}`);
    let contract: Contract;
    try {
        const artifact = contractArtifacts[contractName];

        if (!artifact) {
            throw new Error(`Artifact for ${contractName} not found`);
        }

        const factory = new ethers.ContractFactory(
            artifact.abi,
            artifact.bytecode,
            deployer
        );

        const constructorArgs = params.map(param => {
            if (param.type === "val") {
                return param.value;
            } else {
                throw new Error(`Invalid param type:  + ${param.type}`);
            }
        });

        contract = await factory.deploy(...constructorArgs);
        await contract.waitForDeployment();

        console.log(`${contractName} deployed to: ${contract.target}`);
    } catch (error: any) {
        console.error(`Error deploying ${contractName}:`, error.message);
        throw error;
    }
    return contract;
}

async function callContractFunction(contract: Contract, functionName: string, params: DeploymentParameter[], deployedContracts: { [key: string]: Contract }) {
    console.log(`Calling ${functionName} on ${contract.target}`);

    try {
        const functionArgs = params.map(param => {
            if (param.type === "ref") {
                if (!deployedContracts[param.value]) {
                    throw new Error(`Referenced contract ${param.value} not deployed`);
                }
                return deployedContracts[param.value].target;
            } else if (param.type === "val") {
                return param.value;
            } else {
                throw new Error(`Invalid param type: ${param.type}`);
            }
        });

        const tx = await contract.connect(deployer)[functionName](...functionArgs);
        await tx.wait();

        console.log(`${functionName} executed`);
    } catch (error: any) {
        console.error(`Error calling ${functionName} on ${contract.target}:`, error.message);
        throw error;
    }
}

export async function deployContracts(deploymentInstructionsJson: string): Promise<{ [key: string]: Contract }> {
    const deployedContracts: { [key: string]: Contract } = {};
    let deployer;

    try {
        const deploymentInstructions: DeploymentInstruction = JSON.parse(deploymentInstructionsJson);
        [deployer] = await ethers.getSigners();

        console.log("Deploying contracts with the account:", deployer.address);

        for (const step of deploymentInstructions.sequence) {
            if (step.type === "deploy") {
                const contract = await deployContract(step.contract, step.constructor, deployer, step.params);
                deployedContracts[step.ref_name] = contract;
            } else if (step.type === "call") {
                if (!deployedContracts[step.contract]) {
                    throw new Error(`Contract ${step.contract} not deployed`);
                }
                if (step.function === null) {
                    throw new Error("Function name cannot be null for call type");
                }
                await callContractFunction(deployedContracts[step.contract], step.function, step.params, deployedContracts);
            }
        }

        console.log("All contracts deployed and configured successfully!");
        return deployedContracts;
    } catch (error: any) {
        console.error("Deployment failed:", error.message);
        throw error;
    }
}
