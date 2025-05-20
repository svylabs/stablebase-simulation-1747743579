import { Action, Actor, Account } from "@svylabs/ilumina";
import type { RunContext } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina";
import { Contract} from "ethers";


import { StakeAction } from "../actions/stabilitypool_stake";

import { UnstakeAction } from "../actions/stabilitypool_unstake";

import { ClaimAction } from "../actions/stabilitypool_claim";


export function createStabilityPoolDepositorsActor(account: Account, contracts: Record<string, Contract>): Actor {
    let actor;
    const actions: Action[] = [];
    let action;
    
    action = new StakeAction(contracts.stabilityPool);
    actions.push({action: action, probability: 0.7});
    
    action = new UnstakeAction(contracts.stabilityPool);
    actions.push({action: action, probability: 0.5});
    
    action = new ClaimAction(contracts.stabilityPool);
    actions.push({action: action, probability: 0.6});
    
    actor = new Actor(
        "StabilityPoolDepositors",
        account,
        contracts,
        actions,
    );
    return actor;
}