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
            // Check if the contract has a method to get state or snapshot
            if (contract.getState) {
                snapshotData[name] = await contract.getState(JSON.stringify(identifiers));
            } else if (contract.snapshot) {
                snapshotData[name] = await contract.snapshot(JSON.stringify(identifiers));
            } else {
                // Fallback - store contract as is or empty object
                snapshotData[name] = {};
            }
        }

        return {
            identifiers,
            timestamp: new Date().toISOString(),
            data: snapshotData,
        };
    }
}
