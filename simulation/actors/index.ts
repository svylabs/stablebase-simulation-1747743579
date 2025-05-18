import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Action, Actor, Account } from "@svylabs/ilumina";
import type { RunContext } from "@svylabs/ilumina";
import { Snapshot } from "@svylabs/ilumina";
import { Contract} from "ethers";

export function setupActors(config: any, addrs: HardhatEthersSigner[], contracts: Record<string, Contract>): Actor[] {
   let idx = 0;
   const actors: Actor[] = [];

   return actors;
}