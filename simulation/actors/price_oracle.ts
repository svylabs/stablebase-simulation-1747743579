import { Action, Actor, Account } from "@svylabs/ilumina";
import type { RunContext } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina";
import { Contract} from "ethers";


import { SetPriceAction } from "../actions/mockpriceoracle_set_price";


export function createPriceOracleActor(account: Account, contracts: Record<string, Contract>): Actor {
    let actor;
    const actions: Action[] = [];
    let action;
    
    action = new SetPriceAction(contracts.mockPriceOracle);
    actions.push({action: action, probability: 0.9});
    
    actor = new Actor(
        "PriceOracle",
        account,
        actions,
    );
    return actor;
}