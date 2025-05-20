import { ethers } from 'hardhat';
import { Contract, ContractFactory } from 'ethers';

// Import contract artifacts
import ChainlinkPriceFeedArtifact from '../../../stablebase/artifacts/contracts/dependencies/price-oracle/ChainlinkPriceOracle.sol/ChainlinkPriceFeed.json';
import ConstantsArtifact from '../../../stablebase/artifacts/contracts/Constants.sol/Constants.json';
import DFIDTokenArtifact from '../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json';
import DFIREStakingArtifact from '../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json';
import DFIRETokenArtifact from '../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json';
import MockDebtContractArtifact from '../../../stablebase/artifacts/contracts/MockDebtContract.sol/MockDebtContract.json';
import MockPriceOracleArtifact from '../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json';
import OrderedDoublyLinkedListArtifact from '../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json';
import ReenterDfireStakingArtifact from '../../../stablebase/artifacts/contracts/test/ReenterDfireStaking.sol/ReenterDfireStaking.json';
import ReenterStabilityPoolArtifact from '../../../stablebase/artifacts/contracts/test/ReenterStabilityPool.sol/ReenterStabilityPool.json';
import StabilityPoolArtifact from '../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json';
import StableBaseCDPArtifact from '../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json';
import TestMathArtifact from '../../../stablebase/artifacts/contracts/tests/TestMath.sol/TestMath.json';


interface DeploymentInstruction {
    type: string;
    contract: string;
    constructor: string;
    function: string;
    ref_name: string;
    params: { name: string; value: string; type: string }[];
}

const deploymentInstructions: DeploymentInstruction[] = [
    { "type": "deploy", "contract": "Constants", "constructor": "null", "function": "", "ref_name": "Constants", "params": [] },
    { "type": "deploy", "contract": "DFIDToken", "constructor": "constructor() Ownable(msg.sender) ERC20(\"D.FI Dollar\", \"DFID\") {}", "function": "", "ref_name": "DFIDToken", "params": [] },
    { "type": "call", "contract": "DFIDToken", "constructor": "", "function": "setAddresses", "ref_name": "DFIDToken", "params": [{ "name": "_stableBaseCDP", "value": "StableBaseCDP_address", "type": "ref" }] },
    { "type": "deploy", "contract": "DFIREStaking", "constructor": "constructor(bool _rewardSenderActive) Ownable(msg.sender) {\n        rewardSenderActive = _rewardSenderActive;\n    }", "function": "", "ref_name": "DFIREStaking", "params": [{ "name": "_rewardSenderActive", "value": "true", "type": "val" }] },
    { "type": "call", "contract": "DFIREStaking", "constructor": "", "function": "setAddresses", "ref_name": "DFIREStaking", "params": [{ "name": "_stakingToken", "value": "stakingToken_address", "type": "ref" }, { "name": "_rewardToken", "value": "rewardToken_address", "type": "ref" }, { "name": "_stableBaseContract", "value": "StableBaseCDP_address", "type": "ref" }] },
    { "type": "deploy", "contract": "DFIREToken", "constructor": "constructor() Ownable(msg.sender) ERC20(\"D.FIRE\", \"DFIRE\") {}", "function": "", "ref_name": "DFIREToken", "params": [] },
    { "type": "call", "contract": "DFIREToken", "constructor": "", "function": "setAddresses", "ref_name": "DFIREToken", "params": [{ "name": "_stabilityPool", "value": "StabilityPool_address", "type": "ref" }] },
    { "type": "deploy", "contract": "MockDebtContract", "constructor": "constructor(address _stakingToken) { stakingToken = IERC20(_stakingToken); }", "function": "", "ref_name": "MockDebtContract", "params": [{ "name": "_stakingToken", "value": "stakingToken_address", "type": "ref" }] },
    { "type": "call", "contract": "MockDebtContract", "constructor": "", "function": "setPool", "ref_name": "MockDebtContract", "params": [{ "name": "_pool", "value": "MockDebtContract_address", "type": "ref" }] },
    { "type": "deploy", "contract": "StabilityPool", "constructor": "constructor(bool _rewardSenderActive) Ownable(msg.sender) {\n        rewardSenderActive = _rewardSenderActive;\n    }", "function": "", "ref_name": "StabilityPool", "params": [{ "name": "_rewardSenderActive", "value": "true", "type": "val" }] },
    { "type": "call", "contract": "StabilityPool", "constructor": "", "function": "setAddresses", "ref_name": "StabilityPool", "params": [{ "name": "_stakingToken", "value": "stakingToken_address", "type": "ref" }, { "name": "_stableBaseCDP", "value": "StableBaseCDP_address", "type": "ref" }, { "name": "_sbrToken", "value": "sbrToken_address", "type": "ref" }] },
    { "type": "deploy", "contract": "StableBaseCDP", "constructor": "constructor() StableBase() {}", "function": "", "ref_name": "StableBaseCDP", "params": [] },
    { "type": "call", "contract": "StableBaseCDP", "constructor": "", "function": "setAddresses", "ref_name": "StableBaseCDP", "params": [{ "name": "_sbdToken", "value": "sbdToken_address", "type": "ref" }, { "name": "_priceOracle", "value": "ChainlinkPriceFeed_address", "type": "ref" }, { "name": "_stabilityPool", "value": "StabilityPool_address", "type": "ref" }, { "name": "_dfireTokenStaking", "value": "DFIREStaking_address", "type": "ref" }, { "name": "_safesOrderedForLiquidation", "value": "SafesOrderedForLiquidation_address", "type": "ref" }, { "name": "_safesOrderedForRedemption", "value": "SafesOrderedForRedemption_address", "type": "ref" }] },
    { "type": "deploy", "contract": "OrderedDoublyLinkedList", "constructor": "constructor() Ownable(msg.sender) { head = 0; tail = 0; }", "function": "", "ref_name": "SafesOrderedForLiquidation", "params": [] },
    { "type": "call", "contract": "OrderedDoublyLinkedList", "constructor": "", "function": "setAddresses", "ref_name": "SafesOrderedForLiquidation", "params": [{ "name": "_stableBaseCDP", "value": "StableBaseCDP_address", "type": "ref" }] },
    { "type": "deploy", "contract": "OrderedDoublyLinkedList", "constructor": "constructor() Ownable(msg.sender) { head = 0; tail = 0; }", "function": "", "ref_name": "SafesOrderedForRedemption", "params": [] },
    { "type": "call", "contract": "OrderedDoublyLinkedList", "constructor": "", "function": "setAddresses", "ref_name": "SafesOrderedForRedemption", "params": [{ "name": "_stableBaseCDP", "value": "StableBaseCDP_address", "type": "ref" }] },
    { "type": "deploy", "contract": "ChainlinkPriceFeed", "constructor": "constructor(uint256 chainId) {\n        if (chainId == 1) {\n            // Ethereum Mainnet\n            priceFeed = AggregatorV3Interface(\n                0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419\n            );\n        } else if (chainId == 11155111) {\n            // Sepolia Testnet\n            priceFeed = AggregatorV3Interface(\n                0x694AA1769357215DE4FAC081bf1f309aDC325306\n            );\n        } else if (chainId == 5) {\n            // Goerli Testnet (if needed)\n            priceFeed = AggregatorV3Interface(\n                0xD4a33860578De61DBAbDc8BFdb98FD742fA7028e\n            );\n        } else {\n            revert(\"Unsupported chain ID\");\n        }\n    }", "function": "", "ref_name": "ChainlinkPriceFeed", "params": [{ "name": "chainId", "value": "1", "type": "val" }] },
    { "type": "deploy", "contract": "MockPriceOracle", "constructor": "constructor() Ownable(msg.sender) {  Initializes the Ownable contract, setting the deployer as the owner. }", "function": "", "ref_name": "MockPriceOracle", "params": [] },
    { "type": "deploy", "contract": "ReenterDfireStaking", "constructor": "constructor(address _dfireStaking, address _dfireStakingToken) {\n        dfireStaking = IDFIREStaking(_dfireStaking);\n        stakeToken = IERC20(_dfireStakingToken);\n    }", "function": "", "ref_name": "ReenterDfireStaking", "params": [{ "name": "_dfireStaking", "value": "DFIREStaking_address", "type": "ref" }, { "name": "_dfireStakingToken", "value": "stakingToken_address", "type": "ref" }] },
    { "type": "deploy", "contract": "ReenterStabilityPool", "constructor": "constructor(address _stabilityPool, address _stakeToken) {\n        stabilityPool = IStabilityPool(_stabilityPool);\n        stakeToken = IERC20(_stakeToken);\n    }", "function": "", "ref_name": "ReenterStabilityPool", "params": [{ "name": "_stabilityPool", "value": "StabilityPool_address", "type": "ref" }, { "name": "_stakeToken", "value": "stakingToken_address", "type": "ref" }] },
    { "type": "deploy", "contract": "TestMath", "constructor": "None", "function": "", "ref_name": "TestMath", "params": [] }
];

export async function deployContracts(): Promise<{ [key: string]: Contract }> {
    const [deployer] = await ethers.getSigners();

    console.log("Deploying contracts with the account:", deployer.address);

    const deployedContracts: { [key: string]: Contract } = {};
    const contractAddresses: { [key: string]: string } = {};

    for (const instruction of deploymentInstructions) {
        console.log(`Processing: ${instruction.type} ${instruction.contract} (${instruction.ref_name})`);

        if (instruction.type === 'deploy') {
            let contractFactory: ContractFactory;

            switch (instruction.contract) {
                case 'ChainlinkPriceFeed':
                    contractFactory = new ethers.ContractFactory(
                        ChainlinkPriceFeedArtifact.abi,
                        ChainlinkPriceFeedArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'Constants':
                    contractFactory = new ethers.ContractFactory(
                        ConstantsArtifact.abi,
                        ConstantsArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'DFIDToken':
                    contractFactory = new ethers.ContractFactory(
                        DFIDTokenArtifact.abi,
                        DFIDTokenArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'DFIREStaking':
                    contractFactory = new ethers.ContractFactory(
                        DFIREStakingArtifact.abi,
                        DFIREStakingArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'DFIREToken':
                    contractFactory = new ethers.ContractFactory(
                        DFIRETokenArtifact.abi,
                        DFIRETokenArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'MockDebtContract':
                    contractFactory = new ethers.ContractFactory(
                        MockDebtContractArtifact.abi,
                        MockDebtContractArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'MockPriceOracle':
                    contractFactory = new ethers.ContractFactory(
                        MockPriceOracleArtifact.abi,
                        MockPriceOracleArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'OrderedDoublyLinkedList':
                    contractFactory = new ethers.ContractFactory(
                        OrderedDoublyLinkedListArtifact.abi,
                        OrderedDoublyLinkedListArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'ReenterDfireStaking':
                    contractFactory = new ethers.ContractFactory(
                        ReenterDfireStakingArtifact.abi,
                        ReenterDfireStakingArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'ReenterStabilityPool':
                    contractFactory = new ethers.ContractFactory(
                        ReenterStabilityPoolArtifact.abi,
                        ReenterStabilityPoolArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'StabilityPool':
                    contractFactory = new ethers.ContractFactory(
                        StabilityPoolArtifact.abi,
                        StabilityPoolArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'StableBaseCDP':
                    contractFactory = new ethers.ContractFactory(
                        StableBaseCDPArtifact.abi,
                        StableBaseCDPArtifact.bytecode,
                        deployer
                    );
                    break;
                case 'TestMath':
                    contractFactory = new ethers.ContractFactory(
                        TestMathArtifact.abi,
                        TestMathArtifact.bytecode,
                        deployer
                    );
                    break;
                default:
                    throw new Error(`Unknown contract: ${instruction.contract}`);
            }

            let params: any[] = [];
            for (const param of instruction.params) {
                if (param.type === 'val') {
                    params.push(param.value);
                } else if (param.type === 'ref') {
                  //If it is a reference to another contract, get the address
                  params.push(contractAddresses[param.value]);
                } else {
                    throw new Error(`Invalid parameter type: ${param.type}`);
                }
            }

            try {
              const contract = await contractFactory.deploy(...params);
              await contract.waitForDeployment();

              console.log(`${instruction.contract} deployed to: ${contract.target}`);
              deployedContracts[instruction.ref_name] = contract;
              contractAddresses[instruction.ref_name] = contract.target as string;
            } catch (error) {
              console.error(`Failed to deploy ${instruction.contract}:`, error);
              throw error; // Re-throw the error to halt the deployment
            }


        } else if (instruction.type === 'call') {
            const contract = deployedContracts[instruction.contract];
            if (!contract) {
                throw new Error(`Contract ${instruction.contract} not deployed.`);
            }

            const functionName = instruction.function;
            const params = instruction.params.map(param => {
                if (param.type === 'ref') {
                    if (!contractAddresses[param.value]) {
                        throw new Error(`Referenced contract ${param.value} not deployed.`);
                    }
                    return contractAddresses[param.value];
                } else if (param.type === 'val'){
                    return param.value;
                } else {
                    throw new Error(`Invalid parameter type: ${param.type}`);
                }
            });

            console.log(`Calling ${functionName} on ${instruction.contract} with params:`, params);
            const tx = await contract.connect(deployer)[functionName](...params);
            await tx.wait();
            console.log(`${functionName} called on ${instruction.contract}`);
        }
    }

    console.log('Contracts deployed and configured successfully.');
    return deployedContracts;
}
