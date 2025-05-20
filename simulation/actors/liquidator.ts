import { Action, Actor, Account } from "@svylabs/ilumina";
import type { RunContext } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina";
import { Contract} from "ethers";


import { LiquidateAction } from "../actions/stablebasecdp_liquidate";

import { LiquidateSafeAction } from "../actions/stablebasecdp_liquidate_safe";


export function createLiquidatorActor(account: Account, contracts: Record<string, Contract>): Actor {
    let actor;
    const actions: Action[] = [];
    let action;
    
    action = new LiquidateAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.9});
    
    action = new LiquidateSafeAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.8});
    
    actor = new Actor(
        "Liquidator",
        account,
        contracts,
        actions,
    );
    return actor;
}