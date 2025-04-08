
import {ethers} from 'hardhat';

export async function deployContracts() {
    const [deployer] = await ethers.getSigners();
    const contracts = {};
    // Deploy all required contracts here and add them to the mapping.
    // Return the contracts map
    return contracts;
}
        