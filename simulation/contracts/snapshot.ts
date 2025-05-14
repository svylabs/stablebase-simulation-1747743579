import { SnapshotProvider } from "@svylabs/ilumina";

interface Contract {
    getState?: (identifier?: string) => Promise<any>;
    snapshot?: (identifier?: string) => Promise<any>;
}

export class ContractSnapshotProvider implements SnapshotProvider {
    private contracts: Record<string, Contract>;

    constructor(contracts: Record<string, Contract>) {
        this.contracts = contracts;
    }

    async snapshot(identifiers?: Record<string, string>): Promise<any> {
        identifiers = identifiers || {};
        console.log(`Taking snapshot for identifiers: ${JSON.stringify(identifiers)}`);

        const snapshotData: Record<string, any> = {};

        for (const [name, contract] of Object.entries(this.contracts)) {
            try {
                // Check if the contract has a method to get state or snapshot
                if (contract.getState) {
                    snapshotData[name] = await contract.getState(JSON.stringify(identifiers));
                    console.log(`Snapshot taken for contract ${name} using getState.`);
                } else if (contract.snapshot) {
                    snapshotData[name] = await contract.snapshot(JSON.stringify(identifiers));
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
            identifiers,
            timestamp: new Date().toISOString(),
            data: snapshotData,
        };
    }
}
