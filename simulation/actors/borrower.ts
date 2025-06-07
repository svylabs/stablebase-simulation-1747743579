import { Action, Actor, Account } from "@svylabs/ilumina";
import type { RunContext } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina";
import { Contract} from "ethers";


import { OpenSafeAction } from "../actions/stablebasecdp_open_safe";

import { CloseSafeAction } from "../actions/stablebasecdp_close_safe";

import { BorrowAction } from "../actions/stablebasecdp_borrow";

import { RepayAction } from "../actions/stablebasecdp_repay";

import { AddCollateralAction } from "../actions/stablebasecdp_add_collateral";

import { WithdrawCollateralAction } from "../actions/stablebasecdp_withdraw_collateral";

import { FeeTopupAction } from "../actions/stablebasecdp_fee_topup";


export function createBorrowerActor(account: Account, contracts: Record<string, Contract>): Actor {
    let actor;
    const actions: Action[] = [];
    let action;
    
    action = new OpenSafeAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.7});
    
    action = new CloseSafeAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.3});
    
    action = new BorrowAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.8});
    
    action = new RepayAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.7});
    
    action = new AddCollateralAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.6});
    
    action = new WithdrawCollateralAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.5});
    
    action = new FeeTopupAction(contracts.stableBaseCDP);
    actions.push({action: action, probability: 0.2});
    
    actor = new Actor(
        "Borrower",
        account,
        actions,
    );
    return actor;
}