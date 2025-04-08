#!/usr/bin/env node
import { Actor, Action, Runner, Agent, Environment } from "@svylabs/ilumina";
import type { Account, Web3RunnerOptions, SnapshotProvider, RunContext } from "@svylabs/ilumina";
import {ethers} from 'hardhat';
import { deployContracts} from './contracts/deploy';
import { BorrowAction } from './actions/index';
import { ContractSnapshotProvider } from './contracts/snapshot';

async function main() {
    
    const contracts = await deployContracts();
    const addrs = await ethers.getSigners();

    const env = new Environment();

    // Define Actors here
    const numActors = 10;
    const actors: Actor[] = [];
    for (let i = 0; i < numActors; i++) {
        const account: Account = {
           address: addrs[i].address,
           type: "key",
           value: addrs[i]
        }
        // Pass only the required contract instead of passing all contracts
        const borrowAction = new BorrowAction(contracts);
        const actor = new Actor(
            "Borrower",
            account,
            [],
            [{ action: borrowAction, probability: 0.8 }] // 80% probability
        );
        actors.push(actor);
        env.addAgent(actor);
   }

    // Configure a Runner

    // Initialize and run simulation
    const options = {
        iterations: 10,
        randomSeed: "test-seed",
        shuffleAgents: false
    };

    const snapshotProvider = new ContractSnapshotProvider(contracts);

    const runner = new Runner(actors, snapshotProvider, options);
    await runner.run();
}

console.log(process.argv);
main()
.then(() => {
    console.log("Simulation completed successfully");
    process.exit(0)
})
.catch(error => {
    console.error(error);
    process.exit(1);
});
        