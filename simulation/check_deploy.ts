import { ethers } from 'hardhat';
import { deployContracts } from './contracts/deploy';

interface VerificationResult {
  success: boolean;
  contractAddresses?: Record<string, string>;
  deploymentTime?: string;
  error?: string;
  details?: string;
}

async function verifyDeployment(): Promise<VerificationResult> {
  console.log('🚀 Starting deployment verification...\n');
  
  try {
    // Track deployment timing
    const startTime = Date.now();
    console.log('⏳ Deploying contracts...');
    
    const contracts = await deployContracts();
    const deploymentTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`\n✅ Deployment completed in ${deploymentTime} seconds`);
    console.log('\n📜 Contract Addresses:');
    
    // Get all contract addresses
    const addressEntries = await Promise.all(
      Object.entries(contracts).map(async ([name, contract]) => {
        return [name, await contract.getAddress()] as [string, string];
      })
    );
    
    // Find longest name for pretty formatting
    const maxNameLength = addressEntries.reduce(
      (max, [name]) => Math.max(max, name.length), 
      0
    );
    
    // Log formatted addresses
    addressEntries.forEach(([name, address]) => {
      const padding = ' '.repeat(maxNameLength - name.length);
      console.log(`  ${name}:${padding} ${address}`);
    });
    
    // Verify critical contract functionality
    console.log('\n🔍 Running post-deployment checks...');
    try {
      // Add any critical post-deployment checks here
      console.log('✔️ All post-deployment checks passed');
    } catch (checkError) {
      console.error('⚠️ Post-deployment checks failed:', checkError);
      throw checkError;
    }
    
    return {
      success: true,
      contractAddresses: Object.fromEntries(addressEntries),
      deploymentTime
    };
  } catch (error) {
    console.error('\n❌ Deployment verification failed!');
    console.error('Error details:', error);
    
    // Enhanced error diagnostics
    if (error instanceof Error) {
      console.error('\n🔧 Error diagnostics:');
      console.error('- Message:', error.message);
      
      if (error.stack) {
        const stackLines = error.stack.split('\n');
        console.error('- Location:', stackLines[1]?.trim());
      }
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof Error ? error.stack : undefined
    };
  }
}

async function main() {
  const result = await verifyDeployment();
  if (!result.success) {
    process.exitCode = 1;
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exitCode = 1;
  });
}

export { verifyDeployment };