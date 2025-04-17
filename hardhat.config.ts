import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: "0.8.24",
  networks:{
    hardhat: {
        accounts: {
            count: 500, // Adjust this number for hundreds of accounts
            accountsBalance: "1000000000000000000000" // 1000 ETH per account
        }
    }
  }
};

export default config;
