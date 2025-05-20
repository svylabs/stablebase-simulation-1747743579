import { Action, Actor, Account } from "@svylabs/ilumina";
import type { RunContext } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina";
import { Contract} from "ethers";


import { RedeemAction } from "../actions/stablebasecdp_redeem";


export function createRedeemerActor(account: Account, contracts: Record<string, Contract>): Actor {
    let actor;
    const actions: Action[] = [];
    let action;
    
    action = new RedeemAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.6});
    
    actor = new Actor(
        "Redeemer",
        account,
        contracts,
        actions,
    );
    return actor;
}