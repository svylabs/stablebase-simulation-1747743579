import { Actor, SnapshotProvider } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina/dist/src/run";

interface Contract {
    getState?: () => Promise<any>;
    snapshot?: () => Promise<any>;
}

export class ContractSnapshotProvider implements SnapshotProvider {
    private contracts: Record<string, Contract>;

    constructor(contracts: Record<string, Contract>, actors: Actor[]) {
        this.contracts = contracts;
    }

    async snapshot(): Promise<Snapshot> {
        
        const snapshotData: Record<string, any> = {};

        for (const [name, contract] of Object.entries(this.contracts)) {
            try {
                // Check if the contract has a method to get state or snapshot
                if (contract.getState) {
                    snapshotData[name] = await contract.getState();
                    console.log(`Snapshot taken for contract ${name} using getState.`);
                } else if (contract.snapshot) {
                    snapshotData[name] = await contract.snapshot();
                    console.log(`Snapshot taken for contract ${name} using snapshot.`);
                } else {
                    // Fallback - store contract as is or empty object
                    snapshotData[name] = {};
                    console.warn(`No snapshot method found for contract ${name}.`);
                }
            } catch (error) {
                const err = error as Error;
                console.error(`Error taking snapshot for contract ${name}:`, err.message);
                snapshotData[name] = { error: err.message };
            }
        }

        return {
            contractSnapshot: {},
            actorSnapshot: {}
        }
    }
}
