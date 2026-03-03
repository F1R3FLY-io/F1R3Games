/**
 * ═══════════════════════════════════════════════════════════════════
 * F1R3Beat Shard Integration Service
 * ═══════════════════════════════════════════════════════════════════
 *
 * Game-specific service layer for F1R3Beat.
 *
 * Inherits the core deploy/propose/read cycle and connection logic
 * from the shared F1R3 shard infrastructure (same gRPC bindings,
 * same transport options, same key management). Adds beat-specific
 * operations:
 *
 *   - initGame(): creates a game with time sig, BPM, bars, instruments
 *   - toggleCell(): flip one instrument at one time step on/off
 *   - getGridSnapshot(): efficient full-grid sync
 *   - setBpm(): change shared tempo
 *   - subscribeToGridChanges(): poll for other players' toggles
 *   - subscribeToTransport(): poll for BPM changes
 *
 * The shard interaction pattern is identical to F1R3Pix:
 *   1. Deploy rholang term via DeployService.doDeploy()
 *   2. Propose a block via ProposeService.propose()
 *   3. Read result via DeployService.listenForDataAtName()
 *
 * Architecture:
 *   F1R3Beat React UI
 *     ↕ optimistic local updates
 *   F1R3BeatShardService (this file)
 *     ↕ gRPC (grpc-web or @grpc/grpc-js)
 *   F1R3FLY Shard Node
 *     ↕ rholang contracts (beat-contracts.ts)
 *   On-shard state channels
 */

import { BeatContracts, type GameConfig, type InstrumentDef } from './beat-contracts';

// ─── Re-export shared infrastructure types ─────────────────────────
// These are identical across F1R3Pix, F1R3Beat, and future games.

export interface ShardConfig {
  grpcHost: string;
  grpcPortExternal: number;
  grpcPortInternal: number;
  httpPort: number;
  phloLimit: number;
  phloPrice: number;
  transport: 'grpc-native' | 'grpc-web';
  grpcWebProxyUrl?: string;
}

export interface PlayerIdentity {
  playerId: string;
  privateKey: string;
  publicKey: string;
  revAddress: string;
}

export interface DeployResult {
  success: boolean;
  deployId?: string;
  error?: string;
  cost?: number;
}

export interface ProposeResult {
  success: boolean;
  blockHash?: string;
  error?: string;
}

export interface ShardMessage {
  from: string;
  to: string[];
  text: string;
  timestamp: number;
}

export interface TokenTransfer {
  from: string;
  to: string;
  amount: number;
  deployId: string;
  timestamp: number;
  confirmed: boolean;
}

export type ShardEventCallback<T> = (event: T) => void;

export interface Subscription {
  id: string;
  unsubscribe: () => void;
}

// ─── Beat-specific types ───────────────────────────────────────────

export interface BeatCellState {
  on: boolean;
  owner: string;
  instrument: string;
  timestamp: number;
}

/** Grid snapshot: map of "row,col" -> true for active cells */
export type GridSnapshot = Record<string, boolean>;

export interface TransportState {
  bpm: number;
  playing: boolean;
  updatedBy: string;
  timestamp: number;
}

// ─── Default Config ────────────────────────────────────────────────

export const DEFAULT_SHARD_CONFIG: ShardConfig = {
  grpcHost: 'localhost',
  grpcPortExternal: 40401,
  grpcPortInternal: 40402,
  httpPort: 40403,
  phloLimit: 10_000_000,
  phloPrice: 1,
  transport: 'grpc-web',
};

// ─── Service Class ─────────────────────────────────────────────────

export class F1R3BeatShardService {
  private config: ShardConfig;
  private deployService: any = null;
  private proposeService: any = null;
  private connected = false;
  private subscriptions = new Map<string, { pattern: string; callback: Function; intervalId: any }>();

  constructor(config: Partial<ShardConfig> = {}) {
    this.config = { ...DEFAULT_SHARD_CONFIG, ...config };
  }

  // ═══ CONNECTION ═════════════════════════════════════════════════
  // Identical to F1R3Pix — same gRPC setup, same proto bindings.

  async connect(): Promise<boolean> {
    try {
      if (this.config.transport === 'grpc-native') {
        const grpcLib = await import('@grpc/grpc-js');
        const { rnodeDeploy, rnodePropose } = await import('@tgrospic/rnode-grpc-js');
        const protoSchema = await import('../rnode-grpc-gen/js/pbjs_generated.json');
        await import('../rnode-grpc-gen/js/DeployServiceV1_pb');
        await import('../rnode-grpc-gen/js/ProposeServiceV1_pb');

        this.deployService = rnodeDeploy({
          grpcLib,
          host: `${this.config.grpcHost}:${this.config.grpcPortExternal}`,
          protoSchema,
        });
        this.proposeService = rnodePropose({
          grpcLib,
          host: `${this.config.grpcHost}:${this.config.grpcPortInternal}`,
          protoSchema,
        });
      } else {
        const grpcLib = await import('grpc-web');
        const { rnodeDeploy, rnodePropose } = await import('@tgrospic/rnode-grpc-js');
        const protoSchema = await import('../rnode-grpc-gen/js/pbjs_generated.json');
        await import('../rnode-grpc-gen/js/DeployServiceV1_pb');
        await import('../rnode-grpc-gen/js/ProposeServiceV1_pb');

        const proxyUrl = this.config.grpcWebProxyUrl
          || `http://${this.config.grpcHost}:${this.config.httpPort}`;
        this.deployService = rnodeDeploy({ grpcLib, host: proxyUrl, protoSchema });
        this.proposeService = rnodePropose({ grpcLib, host: proxyUrl, protoSchema });
      }

      this.connected = true;
      console.log(`[F1R3BeatShard] Connected to ${this.config.grpcHost}`);
      return true;
    } catch (err) {
      console.error('[F1R3BeatShard] Connection failed:', err);
      this.connected = false;
      return false;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.deployService = null;
    this.proposeService = null;
    this.subscriptions.forEach(sub => clearInterval(sub.intervalId));
    this.subscriptions.clear();
    console.log('[F1R3BeatShard] Disconnected');
  }

  isConnected(): boolean { return this.connected; }

  // ═══ CORE DEPLOY/PROPOSE/READ ═══════════════════════════════════

  async deploy(rholangTerm: string, identity: PlayerIdentity): Promise<DeployResult> {
    if (!this.connected || !this.deployService) {
      return { success: false, error: 'Not connected to shard' };
    }
    try {
      const { signDeploy } = await import('@tgrospic/rnode-grpc-js');
      const signedDeploy = signDeploy(identity.privateKey, {
        term: rholangTerm,
        phloLimit: this.config.phloLimit,
        phloPrice: this.config.phloPrice,
        validAfterBlockNumber: -1,
        timestamp: Date.now(),
      });
      const response = await this.deployService.doDeploy(signedDeploy);
      if (response && !response.error) {
        return { success: true, deployId: response.result || response };
      }
      return { success: false, error: response?.error?.messages?.join(', ') || 'Deploy failed' };
    } catch (err: any) {
      console.error('[F1R3BeatShard] Deploy error:', err);
      return { success: false, error: err.message };
    }
  }

  async propose(): Promise<ProposeResult> {
    if (!this.connected || !this.proposeService) {
      return { success: false, error: 'Not connected to shard' };
    }
    try {
      const response = await this.proposeService.propose();
      if (response && !response.error) {
        return { success: true, blockHash: response.result || response };
      }
      return { success: false, error: response?.error?.messages?.join(', ') || 'Propose failed' };
    } catch (err: any) {
      console.error('[F1R3BeatShard] Propose error:', err);
      return { success: false, error: err.message };
    }
  }

  async readAtName<T = any>(channelName: string, depth: number = 1): Promise<T | null> {
    if (!this.connected || !this.deployService) return null;
    try {
      const { rhoParToJson } = await import('@tgrospic/rnode-grpc-js');
      const par = { exprs: [{ gString: channelName }] };
      const response = await this.deployService.listenForDataAtName({ depth, name: par });
      if (response?.payload) return rhoParToJson(response.payload) as T;
      return null;
    } catch (err: any) {
      console.error(`[F1R3BeatShard] readAtName(${channelName}) error:`, err);
      return null;
    }
  }

  async deployAndRead<T = any>(
    rholangTerm: string, identity: PlayerIdentity,
    readChannel?: string, autoPropose: boolean = true,
  ): Promise<{ deploy: DeployResult; propose?: ProposeResult; data?: T }> {
    const deployResult = await this.deploy(rholangTerm, identity);
    if (!deployResult.success) return { deploy: deployResult };
    let proposeResult: ProposeResult | undefined;
    if (autoPropose) proposeResult = await this.propose();
    let data: T | undefined;
    if (readChannel) {
      await new Promise(resolve => setTimeout(resolve, 500));
      data = await this.readAtName<T>(readChannel) ?? undefined;
    }
    return { deploy: deployResult, propose: proposeResult, data };
  }

  // ═══ GAME-SPECIFIC OPERATIONS ═══════════════════════════════════

  /**
   * Initialize a new F1R3Beat game on the shard.
   */
  async initGame(config: GameConfig, identity: PlayerIdentity): Promise<DeployResult> {
    const rho = BeatContracts.initGame(config);
    const result = await this.deploy(rho, identity);
    if (result.success) await this.propose();
    return result;
  }

  /**
   * Register a player, assigning them a cell (instrument row + time column).
   */
  async registerPlayer(
    gameId: string, identity: PlayerIdentity,
    cellRow: number, cellCol: number, instrumentId: string,
  ): Promise<DeployResult> {
    const rho = BeatContracts.registerPlayer(
      gameId, identity.playerId, identity.publicKey,
      cellRow, cellCol, instrumentId,
    );
    const result = await this.deploy(rho, identity);
    if (result.success) await this.propose();
    return result;
  }

  /**
   * Toggle a cell on/off — the core game action.
   *
   * Uses optimistic local update:
   *   1. UI toggles immediately (via reducer dispatch)
   *   2. Deploy fires in background
   *   3. Shard confirms asynchronously
   *   4. If deploy fails, UI can revert
   */
  async toggleCell(
    gameId: string, row: number, col: number, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      BeatContracts.toggleCell(gameId, row, col, identity.playerId),
      identity,
    );
    // With autopropose, no manual propose needed
  }

  /**
   * Explicitly set a cell to on or off.
   */
  async setCell(
    gameId: string, row: number, col: number,
    on: boolean, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      BeatContracts.setCell(gameId, row, col, on, identity.playerId),
      identity,
    );
  }

  /**
   * Read a single cell's state.
   */
  async getCellState(
    gameId: string, row: number, col: number, identity: PlayerIdentity,
  ): Promise<BeatCellState | null> {
    const { data } = await this.deployAndRead<BeatCellState>(
      BeatContracts.getCellState(gameId, row, col),
      identity,
      `f1r3beat:${gameId}:grid:${row},${col}`,
    );
    return data ?? null;
  }

  /**
   * Get the full grid snapshot — efficient sync.
   *
   * Returns a map where keys are "row,col" and values are booleans.
   * Only active (on) cells are present in the map.
   * This is ONE deploy instead of (rows × cols) deploys.
   */
  async getGridSnapshot(
    gameId: string, identity: PlayerIdentity,
  ): Promise<GridSnapshot> {
    const { data } = await this.deployAndRead<GridSnapshot>(
      BeatContracts.getGridSnapshot(gameId),
      identity,
      `f1r3beat:${gameId}:grid:snapshot`,
    );
    return data ?? {};
  }

  /**
   * Get all cells for a single instrument row.
   */
  async getInstrumentRow(
    gameId: string, row: number, totalCols: number, identity: PlayerIdentity,
  ): Promise<BeatCellState[]> {
    const { data } = await this.deployAndRead<BeatCellState[]>(
      BeatContracts.getInstrumentRow(gameId, row, totalCols),
      identity,
    );
    return data ?? [];
  }

  /**
   * Read game configuration.
   */
  async getConfig(gameId: string, identity: PlayerIdentity): Promise<GameConfig | null> {
    const { data } = await this.deployAndRead<GameConfig>(
      BeatContracts.getConfig(gameId),
      identity,
      `f1r3beat:${gameId}:config`,
    );
    return data ?? null;
  }

  // ═══ TRANSPORT ══════════════════════════════════════════════════

  /**
   * Change the shared BPM.
   */
  async setBpm(
    gameId: string, bpm: number, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      BeatContracts.setBpm(gameId, bpm, identity.playerId),
      identity,
    );
  }

  /**
   * Read current transport state (BPM, playing, etc.)
   */
  async getTransport(
    gameId: string, identity: PlayerIdentity,
  ): Promise<TransportState | null> {
    const { data } = await this.deployAndRead<TransportState>(
      BeatContracts.getTransport(gameId),
      identity,
      `f1r3beat:${gameId}:transport`,
    );
    return data ?? null;
  }

  // ═══ MESSAGING ══════════════════════════════════════════════════

  async sendMessage(
    gameId: string, toPlayerIds: string[], text: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      BeatContracts.sendMessage(gameId, identity.playerId, toPlayerIds, text),
      identity,
    );
  }

  async readInbox(gameId: string, identity: PlayerIdentity): Promise<ShardMessage[]> {
    const { data } = await this.deployAndRead<ShardMessage[]>(
      BeatContracts.readInbox(gameId, identity.playerId),
      identity,
      `f1r3beat:${gameId}:inbox:${identity.playerId}`,
    );
    return data ?? [];
  }

  // ═══ TOKENS ═════════════════════════════════════════════════════

  async transferTokens(
    toRevAddress: string, amount: number, identity: PlayerIdentity,
  ): Promise<TokenTransfer> {
    const result = await this.deploy(
      BeatContracts.transferTokens(identity.revAddress, toRevAddress, amount),
      identity,
    );
    return {
      from: identity.revAddress, to: toRevAddress, amount,
      deployId: result.deployId || '', timestamp: Date.now(), confirmed: false,
    };
  }

  async getBalance(revAddress: string, identity: PlayerIdentity): Promise<number> {
    const { data } = await this.deployAndRead<number>(
      BeatContracts.getBalance(revAddress), identity,
    );
    return data ?? 0;
  }

  async getPlayers(gameId: string, identity: PlayerIdentity): Promise<any[]> {
    const { data } = await this.deployAndRead<any[]>(
      BeatContracts.getPlayers(gameId), identity,
      `f1r3beat:${gameId}:players`,
    );
    return data ?? [];
  }

  // ═══ SUBSCRIPTIONS (POLLING) ════════════════════════════════════
  // Same pattern as F1R3Pix: poll shard state and fire callbacks
  // when changes are detected. In production, layer a WebSocket
  // server on top.

  /**
   * Subscribe to grid changes via snapshot polling.
   *
   * This is more efficient than F1R3Pix's per-cell polling because
   * we use the snapshot channel (one read per poll cycle) instead
   * of reading each cell individually.
   */
  subscribeToGridChanges(
    gameId: string,
    identity: PlayerIdentity,
    callback: ShardEventCallback<{ key: string; on: boolean }>,
    intervalMs: number = 2000,
  ): Subscription {
    const id = `grid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let knownSnap: GridSnapshot = {};

    const poll = async () => {
      try {
        const snap = await this.getGridSnapshot(gameId, identity);
        // Find changes: cells that flipped on or off
        const allKeys = new Set([...Object.keys(snap), ...Object.keys(knownSnap)]);
        for (const key of allKeys) {
          const wasOn = !!knownSnap[key];
          const isOn = !!snap[key];
          if (wasOn !== isOn) {
            callback({ key, on: isOn });
          }
        }
        knownSnap = snap;
      } catch { /* skip */ }
    };

    const intervalId = setInterval(poll, intervalMs);
    poll(); // Initial sync

    const sub: Subscription = {
      id,
      unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); },
    };
    this.subscriptions.set(id, { pattern: `grid:${gameId}`, callback, intervalId });
    return sub;
  }

  /**
   * Subscribe to transport changes (BPM updates).
   */
  subscribeToTransport(
    gameId: string,
    identity: PlayerIdentity,
    callback: ShardEventCallback<TransportState>,
    intervalMs: number = 3000,
  ): Subscription {
    const id = `transport-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let knownBpm = -1;

    const poll = async () => {
      try {
        const transport = await this.getTransport(gameId, identity);
        if (transport && transport.bpm !== knownBpm) {
          knownBpm = transport.bpm;
          callback(transport);
        }
      } catch { /* skip */ }
    };

    const intervalId = setInterval(poll, intervalMs);

    const sub: Subscription = {
      id,
      unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); },
    };
    this.subscriptions.set(id, { pattern: `transport:${gameId}`, callback, intervalId });
    return sub;
  }

  /**
   * Subscribe to new messages.
   */
  subscribeToMessages(
    gameId: string,
    identity: PlayerIdentity,
    callback: ShardEventCallback<ShardMessage>,
    intervalMs: number = 3000,
  ): Subscription {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const poll = async () => {
      const messages = await this.readInbox(gameId, identity);
      for (const msg of messages) callback(msg);
    };

    const intervalId = setInterval(poll, intervalMs);

    const sub: Subscription = {
      id,
      unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); },
    };
    this.subscriptions.set(id, { pattern: `msg:${gameId}`, callback, intervalId });
    return sub;
  }
}

export default F1R3BeatShardService;
