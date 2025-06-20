// Generated by SnapshotCodeGenerator

import { Snapshot, SnapshotProvider } from "@svylabs/ilumina";
import { Contract } from "ethers";
import { Actor } from "@svylabs/ilumina";



export interface ContractSnapshot {

}

export class ContractSnapshotProvider implements SnapshotProvider {
    private contracts: Record<string, Contract>;
    private actors: Actor[];

    constructor(contracts: Record<string, Contract>, actors: Actor[]) {
        this.contracts = contracts;
        this.actors = actors;
    }

    async snapshot(): Promise<Snapshot> {   
        const snapshot: Snapshot = {
            contractSnapshot: {},
            actorSnapshot: {}
        };
        
        return snapshot;
    }
}