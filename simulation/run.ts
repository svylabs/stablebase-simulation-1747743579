#!/usr/bin/env node
import { Actor, Action, Runner, Agent, Environment } from "@svylabs/ilumina";
import type { Account, Web3RunnerOptions, SnapshotProvider, RunContext } from "@svylabs/ilumina";
import {ethers} from 'hardhat';
import { deployContracts} from './contracts/deploy';
import { ContractSnapshotProvider } from './contracts/snapshot';
import * as config from './config.json';
import { setupActors } from './actors';

async function main() {
    // Validate config
    if (!config.actors || !config.options) {
        throw new Error("Invalid config structure");
    }

    const contracts = await deployContracts();
    const addrs = await ethers.getSigners();

    const env = new Environment();
    let addrIndex = 0;

    // Calculate total required accounts
    const totalActors = Object.values(config.actors).reduce((sum, count) => sum + count, 0);
    if (addrs.length < totalActors) {
        throw new Error(`Not enough accounts (${addrs.length}) for all actors (${totalActors})`);
    }

    const actors = setupActors(config, addrs, contracts);

    for (const actor of actors) {
        env.addAgent(actor);
    }

    // Configure Runner with options from config
    const snapshotProvider = new ContractSnapshotProvider(contracts, actors);
    const runner = new Runner(actors, snapshotProvider, config.options);
    await runner.run();
}

main()
    .then(() => {
        console.log("Simulation completed successfully");
        process.exit(0);
    })
    .catch(error => {
        console.error("Simulation failed:", error);
        process.exit(1);
    });