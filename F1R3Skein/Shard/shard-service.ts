/**
 * F1R3 Shard Service
 * gRPC client for the F1R3FLY shard (rnode).
 * Wraps DeployService and ProposeService from @tgrospic/rnode-grpc-js.
 *
 * All game state is stored on-chain via rholang contracts.
 * Each game deploys its own contracts and reads state via data-at-name.
 */

import { rnodeDeploy, rnodePropose } from "@tgrospic/rnode-grpc-js";

export interface ShardConfig {
  /** gRPC host for the validator node, e.g. "localhost" */
  host: string;
  /** DeployService port, default 40401 */
  deployPort: number;
  /** ProposeService port (internal), default 40402 */
  proposePort: number;
  /** Read-only gRPC port, default 40401 */
  readPort: number;
}

export const DEFAULT_CONFIG: ShardConfig = {
  host: "localhost",
  deployPort: 40401,
  proposePort: 40402,
  readPort: 40401,
};

export interface DeployResult {
  success: boolean;
  deployId?: string;
  blockHash?: string;
  error?: string;
}

export interface DataResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Create a shard service client bound to a specific rnode.
 */
export function createShardService(config: Partial<ShardConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const deployService = rnodeDeploy({
    host: cfg.host,
    port: cfg.deployPort,
  });

  const proposeService = rnodePropose({
    host: cfg.host,
    port: cfg.proposePort,
  });

  /**
   * Deploy rholang source code to the shard.
   * Returns the deploy ID on success.
   */
  async function deploy(
    rholangCode: string,
    privKeyHex: string,
    phloPrice: number = 1,
    phloLimit: number = 500000
  ): Promise<DeployResult> {
    try {
      const deployData = {
        term: rholangCode,
        timestamp: Date.now(),
        phloPrice,
        phloLimit,
        validAfterBlockNumber: -1,
      };

      const result = await deployService.doDeploy(deployData, privKeyHex);

      if (!result || result.error) {
        return { success: false, error: result?.error || "Deploy failed" };
      }

      return { success: true, deployId: result.result };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * Propose a block containing pending deploys.
   */
  async function propose(): Promise<DeployResult> {
    try {
      const result = await proposeService.propose();
      if (!result || result.error) {
        return { success: false, error: result?.error || "Propose failed" };
      }
      return { success: true, blockHash: result.result };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * Deploy rholang and immediately propose.
   * This is the standard write path for game state mutations.
   */
  async function deployAndPropose(
    rholangCode: string,
    privKeyHex: string,
    phloPrice?: number,
    phloLimit?: number
  ): Promise<DeployResult> {
    const deployResult = await deploy(rholangCode, privKeyHex, phloPrice, phloLimit);
    if (!deployResult.success) return deployResult;

    const proposeResult = await propose();
    return {
      success: proposeResult.success,
      deployId: deployResult.deployId,
      blockHash: proposeResult.blockHash,
      error: proposeResult.error,
    };
  }

  /**
   * Read data at a rholang name (channel).
   * Used to query on-chain game state.
   */
  async function dataAtName<T = unknown>(name: string): Promise<DataResult<T>> {
    try {
      const result = await deployService.listenForDataAtName({
        depth: 1,
        name: { unforgeables: [{ gPrivate: name }] },
      });

      if (!result || !result.payload) {
        return { success: false, error: "No data at name" };
      }

      // Parse the rholang value to JS
      const data = parseRhoValue(result.payload) as T;
      return { success: true, data };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * Exploratory deploy — run rholang read-only, no state change.
   * Useful for querying computed state without gas cost.
   */
  async function exploratoryDeploy<T = unknown>(rholangCode: string): Promise<DataResult<T>> {
    try {
      const result = await deployService.exploratoryDeploy({
        term: rholangCode,
      });

      if (!result || result.error) {
        return { success: false, error: result?.error || "Exploratory deploy failed" };
      }

      const data = parseRhoValue(result.result) as T;
      return { success: true, data };
    } catch (e: any) {
      return { success: false, error: e.message || String(e) };
    }
  }

  return {
    deploy,
    propose,
    deployAndPropose,
    dataAtName,
    exploratoryDeploy,
    config: cfg,
  };
}

/**
 * Parse a rholang value (protobuf Par) into a JS value.
 * Handles basic types: strings, ints, bools, lists, maps.
 */
function parseRhoValue(par: any): unknown {
  if (!par) return null;

  // Exprs
  if (par.exprs && par.exprs.length > 0) {
    const expr = par.exprs[0];
    if (expr.gString !== undefined) return expr.gString;
    if (expr.gInt !== undefined) return Number(expr.gInt);
    if (expr.gBool !== undefined) return expr.gBool;
    if (expr.eListBody) {
      return expr.eListBody.ps?.map(parseRhoValue) || [];
    }
    if (expr.eMapBody) {
      const map: Record<string, unknown> = {};
      for (const kv of expr.eMapBody.kvs || []) {
        const key = String(parseRhoValue(kv.key));
        map[key] = parseRhoValue(kv.value);
      }
      return map;
    }
  }

  // Unforgeable names
  if (par.unforgeables && par.unforgeables.length > 0) {
    return par.unforgeables[0].gPrivate || par.unforgeables[0].gDeployerId;
  }

  return null;
}

export type ShardService = ReturnType<typeof createShardService>;
