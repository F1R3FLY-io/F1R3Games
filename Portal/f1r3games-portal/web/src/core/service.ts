// The `shard` capability, over the F1R3Games service: prepare/send for
// writes (the client signs), explore for reads (at an observer). In F1R3Gaze
// the same capability is the shard bridge the browser already has
// (`/api/deploy`, `/api/explore-deploy`); see docs/GAZE-MAPPING.md.

import type { Typed } from "./values";

export interface EnvInfo {
  envUri: string;
  version: number;
  shardId: string;
  coopAddress: string;
  protocol: number;
  phloPrice: number;
  maxPhloLimit: number;
  portalBaseUrl: string;
  faucet: boolean;
}

export interface Prepared {
  template: string;
  templateHash: string;
  args: { [k: string]: Typed };
  derived: { [k: string]: string };
  deploy: { term: string; timestamp: number; phloPrice: number; phloLimit: number; shardId: string };
  prepared: string;
  token: string;
  estimatedCost: number | null;
}

export interface Read {
  ok: boolean;
  value?: Typed;
  error?: string;
  blockHash: string;
  blockNumber: number | null;
}

export interface PrepareRequest {
  template: string;
  game?: string;
  args: { [k: string]: Typed };
  deployer: string;
  derive?: string[];
  phloLimit?: number;
}

export interface Service {
  env(): Promise<EnvInfo>;
  prepare(r: PrepareRequest): Promise<Prepared>;
  send(r: { prepared: string; deployer: string; signature: string; token: string }): Promise<{ deployId: string }>;
  explore(template: string, args: { [k: string]: Typed }, game?: string): Promise<Read>;
  get(path: string): Promise<any>;
  fund(address: string): Promise<{ deployId: string; amount: number }>;
}

export class HttpService implements Service {
  constructor(private base = "", private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.fetchImpl(this.base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) throw new Error(j.error ?? `${r.status} ${path}`);
    return j;
  }

  env() {
    return this.call("GET", "/api/env") as Promise<EnvInfo>;
  }
  prepare(r: PrepareRequest) {
    return this.call("POST", "/api/prepare", r) as Promise<Prepared>;
  }
  send(r: { prepared: string; deployer: string; signature: string; token: string }) {
    return this.call("POST", "/api/send", r) as Promise<{ deployId: string }>;
  }
  explore(template: string, args: { [k: string]: Typed }, game?: string) {
    return this.call("POST", "/api/explore", { template, args, game }) as Promise<Read>;
  }
  get(path: string) {
    return this.call("GET", path);
  }
  fund(address: string) {
    return this.call("POST", "/api/testnet/fund", { address }) as Promise<{ deployId: string; amount: number }>;
  }
}
