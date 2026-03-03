/**
 * ═══════════════════════════════════════════════════════════════════
 * F1R3Pix Shard Integration Service
 * ═══════════════════════════════════════════════════════════════════
 *
 * Full integration layer for connecting F1R3Pix to a F1R3FLY shard.
 *
 * Architecture follows patterns from:
 *   - f1r3drive:  Java FUSE <-> gRPC DeployService (store/retrieve via rholang)
 *   - embers:     Rust wallet agents <-> revVault token operations
 *   - f1r3sky:    React Native social app <-> AT Protocol + shard backing
 *   - rnode-grpc-js: JS/TS bindings for DeployServiceV1 / ProposeServiceV1
 *
 * Dependencies:
 *   npm install @tgrospic/rnode-grpc-js google-protobuf @grpc/grpc-js elliptic
 *   # For browser: npm install google-protobuf grpc-web
 *   # Then generate proto bindings:
 *   #   npx rnode-grpc --rnode-version v0.12.4 --gen-dir ./rnode-grpc-gen
 *
 * Shard setup (from f1r3drive docker-compose):
 *   docker-compose up -d   # starts 2-node shard (validator + observer)
 *   Ports: 40401 (external/deploy), 40402 (internal/propose),
 *          40403 (http), 40400 (protocol), 40404 (discovery)
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface ShardConfig {
  grpcHost: string;
  grpcPortExternal: number;   // DeployService — typically 40401
  grpcPortInternal: number;   // ProposeService — typically 40402
  httpPort: number;            // HTTP API — typically 40403
  phloLimit: number;           // Phlogiston limit per deploy
  phloPrice: number;           // Phlogiston price
  transport: 'grpc-native' | 'grpc-web';
  grpcWebProxyUrl?: string;    // Envoy proxy URL for browser
}

export interface PlayerIdentity {
  playerId: string;
  privateKey: string;          // secp256k1 hex
  publicKey: string;           // secp256k1 hex
  revAddress: string;          // REV address for token ops
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

export interface CellState {
  q: number;
  r: number;
  color: string;
  owner: string;
  timestamp: number;
}

export interface ShardMessage {
  from: string;
  to: string[];
  text: string;
  timestamp: number;
  channel: string;
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

// ─── Default Configuration ─────────────────────────────────────────

export const DEFAULT_SHARD_CONFIG: ShardConfig = {
  grpcHost: 'localhost',
  grpcPortExternal: 40401,
  grpcPortInternal: 40402,
  httpPort: 40403,
  phloLimit: 10_000_000,
  phloPrice: 1,
  transport: 'grpc-web',
};

// ─── Import the contract templates and key management ──────────────

export { RholangContracts } from './rholang-contracts';
export { generateKeyPair, publicKeyFromPrivate, revAddressFromPublicKey, createPlayerIdentity } from './key-management';


// ─── Shard Service Class ───────────────────────────────────────────

export class F1R3PixShardService {
  private config: ShardConfig;
  private deployService: any = null;
  private proposeService: any = null;
  private connected = false;
  private subscriptions = new Map<string, { pattern: string; callback: Function }>();

  constructor(config: Partial<ShardConfig> = {}) {
    this.config = { ...DEFAULT_SHARD_CONFIG, ...config };
  }

  // ─── Connection ────────────────────────────────────────────────

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
      console.log(`[F1R3PixShard] Connected to ${this.config.grpcHost}`);
      return true;
    } catch (err) {
      console.error('[F1R3PixShard] Connection failed:', err);
      this.connected = false;
      return false;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.deployService = null;
    this.proposeService = null;
    this.subscriptions.forEach(sub => sub.callback = () => {});
    this.subscriptions.clear();
    console.log('[F1R3PixShard] Disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Core Deploy/Propose/Read Cycle ────────────────────────────

  async deploy(rholangTerm: string, identity: PlayerIdentity): Promise<DeployResult> {
    if (!this.connected || !this.deployService) {
      return { success: false, error: 'Not connected to shard' };
    }
    try {
      const { signDeploy } = await import('@tgrospic/rnode-grpc-js');
      const deployData = {
        term: rholangTerm,
        phloLimit: this.config.phloLimit,
        phloPrice: this.config.phloPrice,
        validAfterBlockNumber: -1,
        timestamp: Date.now(),
      };
      const signedDeploy = signDeploy(identity.privateKey, deployData);
      const response = await this.deployService.doDeploy(signedDeploy);
      if (response && !response.error) {
        return { success: true, deployId: response.result || response };
      }
      return { success: false, error: response?.error?.messages?.join(', ') || 'Deploy failed' };
    } catch (err: any) {
      console.error('[F1R3PixShard] Deploy error:', err);
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
      console.error('[F1R3PixShard] Propose error:', err);
      return { success: false, error: err.message };
    }
  }

  async readAtName<T = any>(channelName: string, depth: number = 1): Promise<T | null> {
    if (!this.connected || !this.deployService) return null;
    try {
      const { rhoParToJson } = await import('@tgrospic/rnode-grpc-js');
      const par = { exprs: [{ gString: channelName }] };
      const response = await this.deployService.listenForDataAtName({ depth, name: par });
      if (response?.payload) {
        return rhoParToJson(response.payload) as T;
      }
      return null;
    } catch (err: any) {
      console.error(`[F1R3PixShard] readAtName(${channelName}) error:`, err);
      return null;
    }
  }

  async deployAndRead<T = any>(
    rholangTerm: string,
    identity: PlayerIdentity,
    readChannel?: string,
    autoPropose: boolean = true,
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

  // ─── Game-Specific Operations ──────────────────────────────────

  async initGame(gameId: string, identity: PlayerIdentity): Promise<DeployResult> {
    const { RholangContracts } = await import('./rholang-contracts');
    const result = await this.deploy(RholangContracts.initGame(gameId), identity);
    if (result.success) await this.propose();
    return result;
  }

  async registerPlayer(
    gameId: string, identity: PlayerIdentity, cellQ: number, cellR: number,
  ): Promise<DeployResult> {
    const { RholangContracts } = await import('./rholang-contracts');
    const result = await this.deploy(
      RholangContracts.registerPlayer(gameId, identity.playerId, identity.publicKey, cellQ, cellR),
      identity,
    );
    if (result.success) await this.propose();
    return result;
  }

  async setCellColor(
    gameId: string, q: number, r: number, color: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    const { RholangContracts } = await import('./rholang-contracts');
    return this.deploy(
      RholangContracts.setCellColor(gameId, q, r, color, identity.playerId),
      identity,
    );
  }

  async getCellState(
    gameId: string, q: number, r: number, identity: PlayerIdentity,
  ): Promise<CellState | null> {
    const { RholangContracts } = await import('./rholang-contracts');
    const { data } = await this.deployAndRead<CellState>(
      RholangContracts.getCellState(gameId, q, r),
      identity,
      `f1r3pix:${gameId}:grid:${q},${r}`,
    );
    return data ?? null;
  }

  async sendMessage(
    gameId: string, toPlayerIds: string[], text: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    const { RholangContracts } = await import('./rholang-contracts');
    return this.deploy(
      RholangContracts.sendMessage(gameId, identity.playerId, toPlayerIds, text),
      identity,
    );
  }

  async readInbox(gameId: string, identity: PlayerIdentity): Promise<ShardMessage[]> {
    const { RholangContracts } = await import('./rholang-contracts');
    const { data } = await this.deployAndRead<ShardMessage[]>(
      RholangContracts.readInbox(gameId, identity.playerId),
      identity,
      `f1r3pix:${gameId}:inbox:${identity.playerId}`,
    );
    return data ?? [];
  }

  async transferTokens(
    toRevAddress: string, amount: number, identity: PlayerIdentity,
  ): Promise<TokenTransfer> {
    const { RholangContracts } = await import('./rholang-contracts');
    const result = await this.deploy(
      RholangContracts.transferTokens(identity.revAddress, toRevAddress, amount),
      identity,
    );
    return {
      from: identity.revAddress, to: toRevAddress, amount,
      deployId: result.deployId || '', timestamp: Date.now(), confirmed: false,
    };
  }

  async getBalance(revAddress: string, identity: PlayerIdentity): Promise<number> {
    const { RholangContracts } = await import('./rholang-contracts');
    const { data } = await this.deployAndRead<number>(
      RholangContracts.getBalance(revAddress), identity,
    );
    return data ?? 0;
  }

  async getPlayers(gameId: string, identity: PlayerIdentity): Promise<any[]> {
    const { RholangContracts } = await import('./rholang-contracts');
    const { data } = await this.deployAndRead<any[]>(
      RholangContracts.getPlayers(gameId), identity, `f1r3pix:${gameId}:players`,
    );
    return data ?? [];
  }

  // ─── Subscriptions (Polling) ───────────────────────────────────

  subscribeToGridChanges(
    gameId: string, cells: { q: number; r: number }[],
    identity: PlayerIdentity, callback: ShardEventCallback<CellState>,
    intervalMs: number = 2000,
  ): Subscription {
    const id = `grid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const known = new Map<string, string>();

    const poll = async () => {
      for (const { q, r } of cells) {
        try {
          const state = await this.getCellState(gameId, q, r, identity);
          if (state) {
            const key = `${q},${r}`;
            const prev = known.get(key);
            if (prev !== state.color) {
              known.set(key, state.color);
              if (prev !== undefined) callback(state);
            }
          }
        } catch { /* skip */ }
      }
    };

    const intervalId = setInterval(poll, intervalMs);
    poll();

    const sub: Subscription = { id, unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); } };
    this.subscriptions.set(id, { pattern: `grid:${gameId}`, callback });
    return sub;
  }

  subscribeToMessages(
    gameId: string, identity: PlayerIdentity,
    callback: ShardEventCallback<ShardMessage>, intervalMs: number = 3000,
  ): Subscription {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const poll = async () => {
      const messages = await this.readInbox(gameId, identity);
      for (const msg of messages) callback(msg);
    };
    const intervalId = setInterval(poll, intervalMs);
    const sub: Subscription = { id, unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); } };
    this.subscriptions.set(id, { pattern: `msg:${gameId}`, callback });
    return sub;
  }
}

export default F1R3PixShardService;
