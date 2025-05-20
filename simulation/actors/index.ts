import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Action, Actor, Account } from "@svylabs/ilumina";
import type { RunContext } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina";
import { Contract} from "ethers";


import { createBorrowerActor } from "./borrower";

import { createLiquidatorActor } from "./liquidator";

import { createRedeemerActor } from "./redeemer";

import { createDfireStakersActor } from "./dfire_stakers";

import { createStabilityPoolDepositorsActor } from "./stability_pool_depositors";

import { createPriceOracleActor } from "./price_oracle";


export function setupActors(config: any, addrs: HardhatEthersSigner[], contracts: Record<string, Contract>): Actor[] {
   let idx = 0;
   const actors: Actor[] = [];

   
    for (let i = 0; i < config.actors.Borrower; i++) {
        const account: Account = {
            address: addrs[idx].address,
            type: "key",
            value: addrs[idx]
        };
        idx++;
        const actor = createBorrowerActor(account, contracts);
        actors.push(actor);
    }
   
    for (let i = 0; i < config.actors.Liquidator; i++) {
        const account: Account = {
            address: addrs[idx].address,
            type: "key",
            value: addrs[idx]
        };
        idx++;
        const actor = createLiquidatorActor(account, contracts);
        actors.push(actor);
    }
   
    for (let i = 0; i < config.actors.Redeemer; i++) {
        const account: Account = {
            address: addrs[idx].address,
            type: "key",
            value: addrs[idx]
        };
        idx++;
        const actor = createRedeemerActor(account, contracts);
        actors.push(actor);
    }
   
    for (let i = 0; i < config.actors.DfireStakers; i++) {
        const account: Account = {
            address: addrs[idx].address,
            type: "key",
            value: addrs[idx]
        };
        idx++;
        const actor = createDfireStakersActor(account, contracts);
        actors.push(actor);
    }
   
    for (let i = 0; i < config.actors.StabilityPoolDepositors; i++) {
        const account: Account = {
            address: addrs[idx].address,
            type: "key",
            value: addrs[idx]
        };
        idx++;
        const actor = createStabilityPoolDepositorsActor(account, contracts);
        actors.push(actor);
    }
   
    for (let i = 0; i < config.actors.PriceOracle; i++) {
        const account: Account = {
            address: addrs[idx].address,
            type: "key",
            value: addrs[idx]
        };
        idx++;
        const actor = createPriceOracleActor(account, contracts);
        actors.push(actor);
    }
   
   return actors;
}