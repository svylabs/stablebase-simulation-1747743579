import { ethers } from "hardhat";
import * as DFIDTokenArtifact from "../../../stablebase/artifacts/contracts/DFIDToken.sol/DFIDToken.json";
import * as DFIREStakingArtifact from "../../../stablebase/artifacts/contracts/DFIREStaking.sol/DFIREStaking.json";
import * as DFIRETokenArtifact from "../../../stablebase/artifacts/contracts/DFIREToken.sol/DFIREToken.json";
import * as MockPriceOracleArtifact from "../../../stablebase/artifacts/contracts/dependencies/price-oracle/MockPriceOracle.sol/MockPriceOracle.json";
import * as OrderedDoublyLinkedListArtifact from "../../../stablebase/artifacts/contracts/library/OrderedDoublyLinkedList.sol/OrderedDoublyLinkedList.json";
import * as StabilityPoolArtifact from "../../../stablebase/artifacts/contracts/StabilityPool.sol/StabilityPool.json";
import * as StableBaseCDPArtifact from "../../../stablebase/artifacts/contracts/StableBaseCDP.sol/StableBaseCDP.json";


export async function deployContracts() {
    const [deployer] = await ethers.getSigners();

    console.log("Deploying contracts with the account:", deployer.address);

    console.log("Account balance:", (await deployer.getBalance()).toString());

    const dfidTokenFactory = new ethers.ContractFactory(
        DFIDTokenArtifact.abi,
        DFIDTokenArtifact.bytecode,
        deployer
    );
    const dfidToken = await dfidTokenFactory.deploy();
    await dfidToken.waitForDeployment();
    console.log("DFIDToken deployed to:", dfidToken.target);

    const dfireTokenFactory = new ethers.ContractFactory(
        DFIRETokenArtifact.abi,
        DFIRETokenArtifact.bytecode,
        deployer
    );
    const dfireToken = await dfireTokenFactory.deploy();
    await dfireToken.waitForDeployment();
    console.log("DFIREToken deployed to:", dfireToken.target);

    const dfireStakingFactory = new ethers.ContractFactory(
        DFIREStakingArtifact.abi,
        DFIREStakingArtifact.bytecode,
        deployer
    );
    const dfireStaking = await dfireStakingFactory.deploy(true);
    await dfireStaking.waitForDeployment();
    console.log("DFIREStaking deployed to:", dfireStaking.target);

    const stabilityPoolFactory = new ethers.ContractFactory(
        StabilityPoolArtifact.abi,
        StabilityPoolArtifact.bytecode,
        deployer
    );
    const stabilityPool = await stabilityPoolFactory.deploy(true);
    await stabilityPool.waitForDeployment();
    console.log("StabilityPool deployed to:", stabilityPool.target);

    const stableBaseCDPFactory = new ethers.ContractFactory(
        StableBaseCDPArtifact.abi,
        StableBaseCDPArtifact.bytecode,
        deployer
    );
    const stableBaseCDP = await stableBaseCDPFactory.deploy();
    await stableBaseCDP.waitForDeployment();
    console.log("StableBaseCDP deployed to:", stableBaseCDP.target);

    const safesOrderedForLiquidationFactory = new ethers.ContractFactory(
        OrderedDoublyLinkedListArtifact.abi,
        OrderedDoublyLinkedListArtifact.bytecode,
        deployer
    );
    const safesOrderedForLiquidation = await safesOrderedForLiquidationFactory.deploy();
    await safesOrderedForLiquidation.waitForDeployment();
    console.log("SafesOrderedForLiquidation deployed to:", safesOrderedForLiquidation.target);

    const safesOrderedForRedemptionFactory = new ethers.ContractFactory(
        OrderedDoublyLinkedListArtifact.abi,
        OrderedDoublyLinkedListArtifact.bytecode,
        deployer
    );
    const safesOrderedForRedemption = await safesOrderedForRedemptionFactory.deploy();
    await safesOrderedForRedemption.waitForDeployment();
    console.log("SafesOrderedForRedemption deployed to:", safesOrderedForRedemption.target);

    const mockPriceOracleFactory = new ethers.ContractFactory(
        MockPriceOracleArtifact.abi,
        MockPriceOracleArtifact.bytecode,
        deployer
    );
    const mockPriceOracle = await mockPriceOracleFactory.deploy();
    await mockPriceOracle.waitForDeployment();
    console.log("MockPriceOracle deployed to:", mockPriceOracle.target);

    // Set Addresses
    let tx = await dfidToken.connect(deployer).setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("DFIDToken setAddresses");

    tx = await dfireToken.connect(deployer).setAddresses(stabilityPool.target);
    await tx.wait();
    console.log("DFIREToken setAddresses");

    tx = await dfireStaking.connect(deployer).setAddresses(dfireToken.target, dfidToken.target, stableBaseCDP.target);
    await tx.wait();
    console.log("DFIREStaking setAddresses");

    tx = await stabilityPool.connect(deployer).setAddresses(dfidToken.target, stableBaseCDP.target, dfireToken.target);
    await tx.wait();
    console.log("StabilityPool setAddresses");

    tx = await stableBaseCDP.connect(deployer).setAddresses(
        dfidToken.target,
        mockPriceOracle.target,
        stabilityPool.target,
        dfireStaking.target,
        safesOrderedForLiquidation.target,
        safesOrderedForRedemption.target
    );
    await tx.wait();
    console.log("StableBaseCDP setAddresses");

    tx = await safesOrderedForLiquidation.connect(deployer).setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("SafesOrderedForLiquidation setAddresses");

    tx = await safesOrderedForRedemption.connect(deployer).setAddresses(stableBaseCDP.target);
    await tx.wait();
    console.log("SafesOrderedForRedemption setAddresses");

    return {
        dfidToken,
        dfireToken,
        dfireStaking,
        stabilityPool,
        stableBaseCDP,
        safesOrderedForLiquidation,
        safesOrderedForRedemption,
        mockPriceOracle
    };
}
