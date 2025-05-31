import { ethers } from 'hardhat';
import { deployContracts } from './contracts/deploy';
import { ContractSnapshotProvider } from './contracts/snapshot';

async function main() {
    console.log('🚀 Starting snapshot verification...\n');

    try {
        // Track deployment timing
        const startTime = Date.now();
        console.log('⏳ Deploying contracts...');

        const contracts = await deployContracts();
        const deploymentTime = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log(`\n✅ Deployment completed in ${deploymentTime} seconds`);
        console.log('\n📜 Contract Addresses:');

        // Get all contract addresses
        Object.entries(contracts).forEach( async ([name, contract]) => {
            console.log([name, await contract.getAddress()] as [string, string]);
        })

        const provider: ContractSnapshotProvider = new ContractSnapshotProvider(contracts, []);
        const snapshot = await provider.snapshot();
        console.log('\n📸 Snapshot taken successfully:', snapshot);


    } catch (error) {
        const err = error as Error;
        console.error('❌ Deployment verification failed:', err.message);
        return { success: false, error: err.message };
    }

    return { success: true };
}

main()
    .then(result => {
        if (result.success) {
            console.log('✅ Snapshot verification completed successfully');
        } else {
            console.error('❌ Snapshot verification failed:', result.error);
        }
    })
    .catch(error => {
        console.error('❌ Unexpected error during snapshot verification:', error);
    });
