/**
 * ═══════════════════════════════════════════════════════════════════
 * F1R3SideChat Shard Integration Service
 * ═══════════════════════════════════════════════════════════════════
 *
 * Architecture:
 *   F1R3SideChat React UI
 *     ↕ optimistic local updates
 *   F1R3SideChatShardService (this file)
 *     ↕ gRPC (grpc-web or @grpc/grpc-js)
 *   F1R3FLY Shard Node
 *     ↕ rholang contracts (sidechat-contracts.ts)
 *   On-shard state channels
 *
 * Key differences from F1R3Pix / F1R3Beat:
 *   - No grid — state is narrative (chapters, characters, comments)
 *   - Role transitions: consumer -> creator (costs tokens)
 *   - AI co-author sessions stored on-shard
 *   - Tip ledger for rewarding contributions
 *   - Global story index for per-category browsing
 */

import {
  SideChatContracts,
  TOKEN_COSTS,
  type StoryConfig,
  type CharacterDef,
  type ChapterDef,
  type UserRole,
} from './sidechat-contracts';

// ─── Shared types ──────────────────────────────────────────────────

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

// ─── SideChat-specific types ───────────────────────────────────────

export interface StoryMeta {
  storyId: string;
  title: string;
  genre: string;
  synopsis: string;
  authorId: string;
  readers: number;
  created: number;
}

export interface ChapterContent {
  text: string;
  wordCount: number;
  applause: number;
  lastEditor: string;
  revisions: { editor: string; action: string; ts: number }[];
  timestamp: number;
}

export interface CharacterState {
  id: string;
  name: string;
  role: string;
  driver: string | null;
  driverHistory: { player: string; ts: number }[];
}

export interface CommentData {
  id: number;
  user: string;
  text: string;
  applause: number;
  timestamp: number;
}

export interface TipRecord {
  from: string;
  to: string;
  amount: number;
  context: string;
  timestamp: number;
}

export interface AISession {
  sessionId: string;
  player: string;
  chapter: string;
  messages: { role: 'user' | 'ai'; text: string; ts: number }[];
  generatedText: string[];
  created: number;
}

export interface StoryIndexEntry {
  storyId: string;
  title: string;
  genre: string;
  author: string;
  created: number;
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

export class F1R3SideChatShardService {
  private config: ShardConfig;
  private deployService: any = null;
  private proposeService: any = null;
  private connected = false;
  private subscriptions = new Map<string, { pattern: string; callback: Function; intervalId: any }>();

  constructor(config: Partial<ShardConfig> = {}) {
    this.config = { ...DEFAULT_SHARD_CONFIG, ...config };
  }

  // ═══ CONNECTION ═════════════════════════════════════════════════

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
      console.log(`[F1R3SideChatShard] Connected to ${this.config.grpcHost}`);
      return true;
    } catch (err) {
      console.error('[F1R3SideChatShard] Connection failed:', err);
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
    console.log('[F1R3SideChatShard] Disconnected');
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
      console.error('[F1R3SideChatShard] Deploy error:', err);
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
      console.error('[F1R3SideChatShard] Propose error:', err);
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
      console.error(`[F1R3SideChatShard] readAtName(${channelName}) error:`, err);
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

  // ═══ STORY LIFECYCLE ════════════════════════════════════════════

  async initStory(config: StoryConfig, identity: PlayerIdentity): Promise<DeployResult> {
    const result = await this.deploy(SideChatContracts.initStory(config), identity);
    if (result.success) {
      await this.propose();
      // Register in the global index for browsing
      await this.deploy(
        SideChatContracts.registerInIndex(config.storyId, config.title, config.genre, config.authorId),
        identity,
      );
      await this.propose();
    }
    return result;
  }

  async getStoryMeta(storyId: string, identity: PlayerIdentity): Promise<StoryMeta | null> {
    const { data } = await this.deployAndRead<StoryMeta>(
      SideChatContracts.getStoryMeta(storyId), identity,
      `f1r3sidechat:${storyId}:meta`,
    );
    return data ?? null;
  }

  async incrementReaders(storyId: string, identity: PlayerIdentity): Promise<DeployResult> {
    return this.deploy(SideChatContracts.incrementReaders(storyId), identity);
  }

  // ═══ PLAYER MANAGEMENT ══════════════════════════════════════════

  async registerPlayer(storyId: string, identity: PlayerIdentity): Promise<DeployResult> {
    const result = await this.deploy(
      SideChatContracts.registerPlayer(storyId, identity.playerId, identity.publicKey),
      identity,
    );
    if (result.success) await this.propose();
    return result;
  }

  async getPlayers(storyId: string, identity: PlayerIdentity): Promise<any[]> {
    const { data } = await this.deployAndRead<any[]>(
      SideChatContracts.getPlayers(storyId), identity,
      `f1r3sidechat:${storyId}:players`,
    );
    return data ?? [];
  }

  async promoteToCreator(storyId: string, playerId: string, identity: PlayerIdentity): Promise<DeployResult> {
    return this.deploy(SideChatContracts.promoteToCreator(storyId, playerId), identity);
  }

  // ═══ CHARACTERS ═════════════════════════════════════════════════

  async addCharacter(
    storyId: string, charId: string, name: string, role: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    const result = await this.deploy(
      SideChatContracts.addCharacter(storyId, charId, name, role), identity,
    );
    if (result.success) await this.propose();
    return result;
  }

  async getCharacters(storyId: string, identity: PlayerIdentity): Promise<CharacterState[]> {
    const { data } = await this.deployAndRead<CharacterState[]>(
      SideChatContracts.getCharacters(storyId), identity,
      `f1r3sidechat:${storyId}:characters`,
    );
    return data ?? [];
  }

  /**
   * Take the wheel on a character.
   *
   * Full flow:
   *   1. Transfer TAKE_WHEEL tokens to the story's escrow
   *   2. Deploy the takeTheWheel contract
   *   3. If the player was a consumer, promote to creator
   *   4. Propose block
   */
  async takeTheWheel(
    storyId: string, charId: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    // Step 1: Pay tokens
    const payResult = await this.deploy(
      SideChatContracts.transferTokens(
        identity.revAddress,
        `f1r3sidechat-escrow-${storyId}`,
        TOKEN_COSTS.TAKE_WHEEL,
      ),
      identity,
    );
    if (!payResult.success) return payResult;

    // Step 2: Take the wheel
    const wheelResult = await this.deploy(
      SideChatContracts.takeTheWheel(storyId, charId, identity.playerId),
      identity,
    );

    // Step 3: Promote to creator
    await this.deploy(
      SideChatContracts.promoteToCreator(storyId, identity.playerId),
      identity,
    );

    // Step 4: Propose
    await this.propose();

    return wheelResult;
  }

  async releaseWheel(
    storyId: string, charId: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    const result = await this.deploy(
      SideChatContracts.releaseWheel(storyId, charId, identity.playerId),
      identity,
    );
    if (result.success) await this.propose();
    return result;
  }

  // ═══ CHAPTERS ═══════════════════════════════════════════════════

  async addChapter(
    storyId: string, chapterId: string, num: number, title: string,
    status: 'open' | 'published', identity: PlayerIdentity,
  ): Promise<DeployResult> {
    const result = await this.deploy(
      SideChatContracts.addChapter(storyId, chapterId, num, title, status, identity.playerId),
      identity,
    );
    if (result.success) await this.propose();
    return result;
  }

  async getChapters(storyId: string, identity: PlayerIdentity): Promise<ChapterDef[]> {
    const { data } = await this.deployAndRead<ChapterDef[]>(
      SideChatContracts.getChapters(storyId), identity,
      `f1r3sidechat:${storyId}:chapters`,
    );
    return data ?? [];
  }

  async writeChapter(
    storyId: string, chapterId: string, text: string,
    identity: PlayerIdentity, append: boolean = true,
  ): Promise<DeployResult> {
    const result = await this.deploy(
      SideChatContracts.writeChapter(storyId, chapterId, text, identity.playerId, append),
      identity,
    );
    if (result.success) await this.propose();
    return result;
  }

  async getChapterContent(
    storyId: string, chapterId: string, identity: PlayerIdentity,
  ): Promise<ChapterContent | null> {
    const { data } = await this.deployAndRead<ChapterContent>(
      SideChatContracts.getChapterContent(storyId, chapterId), identity,
      `f1r3sidechat:${storyId}:ch:${chapterId}:content`,
    );
    return data ?? null;
  }

  async publishChapter(
    storyId: string, chapterId: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      SideChatContracts.publishChapter(storyId, chapterId, identity.playerId),
      identity,
    );
  }

  async applaudChapter(
    storyId: string, chapterId: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      SideChatContracts.applaudChapter(storyId, chapterId), identity,
    );
  }

  // ═══ COMMENTS ═══════════════════════════════════════════════════

  async addComment(
    storyId: string, chapterId: string, text: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      SideChatContracts.addComment(storyId, chapterId, identity.playerId, text),
      identity,
    );
  }

  async getComments(
    storyId: string, chapterId: string, identity: PlayerIdentity,
  ): Promise<CommentData[]> {
    const { data } = await this.deployAndRead<CommentData[]>(
      SideChatContracts.getComments(storyId, chapterId), identity,
      `f1r3sidechat:${storyId}:ch:${chapterId}:comments`,
    );
    return data ?? [];
  }

  async applaudComment(
    storyId: string, chapterId: string, commentId: number, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      SideChatContracts.applaudComment(storyId, chapterId, commentId), identity,
    );
  }

  // ═══ TIPS ═══════════════════════════════════════════════════════

  /**
   * Tip a contributor.
   * Transfers tokens + records in the tip ledger.
   */
  async tip(
    storyId: string, toPlayerId: string, toRevAddress: string,
    amount: number, context: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    // Transfer tokens
    const transferResult = await this.deploy(
      SideChatContracts.transferTokens(identity.revAddress, toRevAddress, amount),
      identity,
    );
    if (!transferResult.success) return transferResult;

    // Record in tip ledger
    const recordResult = await this.deploy(
      SideChatContracts.recordTip(storyId, identity.playerId, toPlayerId, amount, context),
      identity,
    );

    await this.propose();
    return recordResult;
  }

  async getTips(storyId: string, identity: PlayerIdentity): Promise<TipRecord[]> {
    const { data } = await this.deployAndRead<TipRecord[]>(
      SideChatContracts.getTips(storyId), identity,
      `f1r3sidechat:${storyId}:tips`,
    );
    return data ?? [];
  }

  // ═══ AI CO-AUTHOR ═══════════════════════════════════════════════

  /**
   * Start an AI co-author session.
   * Costs AI_COAUTHOR tokens.
   */
  async startAISession(
    storyId: string, chapterId: string, identity: PlayerIdentity,
  ): Promise<{ sessionId: string; deploy: DeployResult }> {
    const sessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Pay tokens
    const payResult = await this.deploy(
      SideChatContracts.transferTokens(
        identity.revAddress,
        `f1r3sidechat-ai-${storyId}`,
        TOKEN_COSTS.AI_COAUTHOR,
      ),
      identity,
    );
    if (!payResult.success) return { sessionId, deploy: payResult };

    // Create session
    const result = await this.deploy(
      SideChatContracts.createAISession(storyId, sessionId, identity.playerId, chapterId),
      identity,
    );
    await this.propose();

    return { sessionId, deploy: result };
  }

  async appendAIMessage(
    storyId: string, sessionId: string,
    role: 'user' | 'ai', text: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      SideChatContracts.appendAIMessage(storyId, sessionId, role, text),
      identity,
    );
  }

  async getAISession(
    storyId: string, sessionId: string, identity: PlayerIdentity,
  ): Promise<AISession | null> {
    const { data } = await this.deployAndRead<AISession>(
      SideChatContracts.getAISession(storyId, sessionId), identity,
      `f1r3sidechat:${storyId}:ai:${sessionId}`,
    );
    return data ?? null;
  }

  // ═══ MESSAGING ══════════════════════════════════════════════════

  async sendMessage(
    storyId: string, toPlayerIds: string[], text: string, identity: PlayerIdentity,
  ): Promise<DeployResult> {
    return this.deploy(
      SideChatContracts.sendMessage(storyId, identity.playerId, toPlayerIds, text),
      identity,
    );
  }

  async readInbox(storyId: string, identity: PlayerIdentity): Promise<ShardMessage[]> {
    const { data } = await this.deployAndRead<ShardMessage[]>(
      SideChatContracts.readInbox(storyId, identity.playerId), identity,
      `f1r3sidechat:${storyId}:inbox:${identity.playerId}`,
    );
    return data ?? [];
  }

  // ═══ TOKENS ═════════════════════════════════════════════════════

  async transferTokens(
    toRevAddress: string, amount: number, identity: PlayerIdentity,
  ): Promise<TokenTransfer> {
    const result = await this.deploy(
      SideChatContracts.transferTokens(identity.revAddress, toRevAddress, amount),
      identity,
    );
    return {
      from: identity.revAddress, to: toRevAddress, amount,
      deployId: result.deployId || '', timestamp: Date.now(), confirmed: false,
    };
  }

  async getBalance(revAddress: string, identity: PlayerIdentity): Promise<number> {
    const { data } = await this.deployAndRead<number>(
      SideChatContracts.getBalance(revAddress), identity,
    );
    return data ?? 0;
  }

  // ═══ STORY DISCOVERY (PER-CATEGORY BROWSER) ═════════════════════

  /**
   * Get all stories in the global F1R3SideChat index.
   * Used by the per-category browser on the portal landing page.
   */
  async getStoryIndex(identity: PlayerIdentity): Promise<StoryIndexEntry[]> {
    const { data } = await this.deployAndRead<StoryIndexEntry[]>(
      SideChatContracts.getStoryIndex(), identity,
      'f1r3sidechat:index',
    );
    return data ?? [];
  }

  /**
   * Initialize the global story index.
   * Deploy once when setting up the shard.
   */
  async initStoryIndex(identity: PlayerIdentity): Promise<DeployResult> {
    const result = await this.deploy(SideChatContracts.initIndex(), identity);
    if (result.success) await this.propose();
    return result;
  }

  // ═══ SUBSCRIPTIONS ══════════════════════════════════════════════

  /**
   * Poll for new comments on a chapter.
   */
  subscribeToComments(
    storyId: string, chapterId: string, identity: PlayerIdentity,
    callback: ShardEventCallback<CommentData>,
    intervalMs: number = 3000,
  ): Subscription {
    const id = `comments-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let knownCount = 0;

    const poll = async () => {
      try {
        const comments = await this.getComments(storyId, chapterId, identity);
        if (comments.length > knownCount) {
          const newComments = comments.slice(knownCount);
          for (const c of newComments) callback(c);
          knownCount = comments.length;
        }
      } catch { /* skip */ }
    };

    const intervalId = setInterval(poll, intervalMs);
    poll();

    const sub: Subscription = {
      id,
      unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); },
    };
    this.subscriptions.set(id, { pattern: `comments:${storyId}:${chapterId}`, callback, intervalId });
    return sub;
  }

  /**
   * Poll for chapter content changes (new writing from other creators).
   */
  subscribeToChapterUpdates(
    storyId: string, chapterId: string, identity: PlayerIdentity,
    callback: ShardEventCallback<ChapterContent>,
    intervalMs: number = 5000,
  ): Subscription {
    const id = `ch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let knownTs = 0;

    const poll = async () => {
      try {
        const content = await this.getChapterContent(storyId, chapterId, identity);
        if (content && content.timestamp > knownTs) {
          knownTs = content.timestamp;
          callback(content);
        }
      } catch { /* skip */ }
    };

    const intervalId = setInterval(poll, intervalMs);

    const sub: Subscription = {
      id,
      unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); },
    };
    this.subscriptions.set(id, { pattern: `chapter:${storyId}:${chapterId}`, callback, intervalId });
    return sub;
  }

  /**
   * Poll for character driver changes.
   */
  subscribeToCharacterChanges(
    storyId: string, identity: PlayerIdentity,
    callback: ShardEventCallback<CharacterState[]>,
    intervalMs: number = 4000,
  ): Subscription {
    const id = `chars-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let knownDrivers = '';

    const poll = async () => {
      try {
        const chars = await this.getCharacters(storyId, identity);
        const driverStr = chars.map(c => `${c.id}:${c.driver}`).join(',');
        if (driverStr !== knownDrivers) {
          knownDrivers = driverStr;
          callback(chars);
        }
      } catch { /* skip */ }
    };

    const intervalId = setInterval(poll, intervalMs);

    const sub: Subscription = {
      id,
      unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); },
    };
    this.subscriptions.set(id, { pattern: `chars:${storyId}`, callback, intervalId });
    return sub;
  }

  /**
   * Poll for new messages.
   */
  subscribeToMessages(
    storyId: string, identity: PlayerIdentity,
    callback: ShardEventCallback<ShardMessage>,
    intervalMs: number = 3000,
  ): Subscription {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const poll = async () => {
      const messages = await this.readInbox(storyId, identity);
      for (const msg of messages) callback(msg);
    };

    const intervalId = setInterval(poll, intervalMs);

    const sub: Subscription = {
      id,
      unsubscribe: () => { clearInterval(intervalId); this.subscriptions.delete(id); },
    };
    this.subscriptions.set(id, { pattern: `msg:${storyId}`, callback, intervalId });
    return sub;
  }
}

export { TOKEN_COSTS };
export default F1R3SideChatShardService;
