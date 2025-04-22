#!/usr/bin/env node
import { Actor, Action, Runner, Agent, Environment } from "@svylabs/ilumina";
import type { Account, Web3RunnerOptions, SnapshotProvider, RunContext } from "@svylabs/ilumina";
import {ethers} from 'hardhat';
import { deployContracts} from './contracts/deploy';
import { ContractSnapshotProvider } from './contracts/snapshot';
import * as config from './config.json';

async function main() {
    // Validate config
    if (!config.actors || !config.options) {
        throw new Error("Invalid config structure");
    }

    const contracts = await deployContracts();
    const addrs = await ethers.getSigners();

    const env = new Environment();
    const actors: Actor[] = [];
    let addrIndex = 0;

    // Calculate total required accounts
    const totalActors = Object.values(config.actors).reduce((sum, count) => sum + count, 0);
    if (addrs.length < totalActors) {
        throw new Error(`Not enough accounts (${addrs.length}) for all actors (${totalActors})`);
    }

    // Create actors based on config
    for (const [actorType, count] of Object.entries(config.actors)) {
        for (let i = 0; i < count; i++) {
            const account: Account = {
                address: addrs[addrIndex].address,
                type: "key",
                value: addrs[addrIndex]
            };
            
            const actor = new Actor(
                actorType,
                account,
                [], // Actions will be added later
                [] // Action probabilities will be added later
            );
            
            actors.push(actor);
            env.addAgent(actor);
            addrIndex++;
        }
    }

    // Configure Runner with options from config
    const snapshotProvider = new ContractSnapshotProvider(contracts);
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