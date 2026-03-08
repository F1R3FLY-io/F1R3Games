// ============================================================
// F1R3SideChat Shard Client
// src/shardClient.js
//
// Communicates with the F1R3FLY shard via gRPC using
// @tgrospic/rnode-grpc-js — matching the pattern from
// F1R3Pix and F1R3Beat.
//
// Handles: deploy, propose, identity (P-256 keypair),
// revVault queries, and contract return-value reading.
// ============================================================

import {
  rnodeProtobuf,
  signDeploy,
  verifyDeploy,
  getDeployData,
} from '@tgrospic/rnode-grpc-js';

import { ec as EC } from 'elliptic';
import { keccak256 } from 'js-sha3';
import { v4 as uuidv4 } from 'uuid';

// ── Configuration ────────────────────────────────────────────
const DEFAULT_SHARD_URL  = 'http://localhost:40401';
const PROPOSE_SHARD_URL  = 'http://localhost:40402'; // validator port
const PHLO_LIMIT         = 500000;
const PHLO_PRICE         = 1;
const VALID_AFTER_BLOCK  = -1;

// Registry URIs (populated after contract deploy)
const REGISTRY_URIS = {
  storyRegistry:       'rho:id:f1r3sidechat:storyRegistry',
  kibitzRegistry:      'rho:id:f1r3sidechat:kibitzRegistry',
  metaProposalRegistry:'rho:id:f1r3sidechat:metaProposalRegistry',
  personaRegistry:     'rho:id:f1r3sidechat:personaRegistry',
};

// ── Elliptic curve (P-256 = secp256r1 = prime256v1) ──────────
const ec = new EC('p256');

// ── Identity ─────────────────────────────────────────────────

/**
 * Generate a fresh P-256 keypair.
 * Returns { privateKeyHex, publicKeyHex, revAddress }
 */
export function generateIdentity() {
  const keyPair   = ec.genKeyPair();
  const privHex   = keyPair.getPrivate('hex');
  const pubHex    = keyPair.getPublic(false, 'hex'); // uncompressed
  const revAddr   = pubKeyToRevAddress(pubHex);
  return { privateKeyHex: privHex, publicKeyHex: pubHex, revAddress: revAddr };
}

/**
 * Restore an identity from a stored private key hex string.
 */
export function restoreIdentity(privateKeyHex) {
  const keyPair = ec.keyFromPrivate(privateKeyHex, 'hex');
  const pubHex  = keyPair.getPublic(false, 'hex');
  const revAddr = pubKeyToRevAddress(pubHex);
  return { privateKeyHex, publicKeyHex: pubHex, revAddress: revAddr };
}

/**
 * Derive a rev address from a public key.
 * Mirrors the RChain / F1R3FLY convention:
 *   revAddr = "1111" + base58check( keccak256( pubkey_bytes )[12:] )
 * This is a simplified version; production should use the full
 * rnode crypto library's `ETH.publicKeyToRevAddress`.
 */
function pubKeyToRevAddress(pubKeyHex) {
  const pubBytes  = hexToBytes(pubKeyHex);
  const hash      = keccak256.array(pubBytes);
  const addrBytes = hash.slice(12); // last 20 bytes
  return '1111' + bytesToBase58(addrBytes);
}

// ── Sigil Avatar ─────────────────────────────────────────────
// Deterministic geometric sigil from pubkey — shared across F1R3Games

/**
 * Generate a sigil SVG string from a public key hex.
 * Uses the first 32 bytes of the key to drive shape parameters.
 */
export function pubKeyToSigilSVG(pubKeyHex, size = 40) {
  const bytes = hexToBytes(pubKeyHex).slice(0, 32);
  const hue   = ((bytes[0] << 8 | bytes[1]) % 360);
  const shape = bytes[2] % 4; // 0=hexagon 1=diamond 2=triangle 3=circle+cross
  const r     = size / 2;
  const cx    = r, cy = r;

  const hslMain = `hsl(${hue},80%,60%)`;
  const hslDark = `hsl(${hue},60%,15%)`;

  let inner = '';
  if (shape === 0) {
    // Hexagon
    const pts = Array.from({length: 6}, (_,i) => {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      return `${cx + r*0.72*Math.cos(a)},${cy + r*0.72*Math.sin(a)}`;
    }).join(' ');
    inner = `<polygon points="${pts}" fill="none" stroke="${hslMain}" stroke-width="1.5"/>`;
  } else if (shape === 1) {
    // Diamond
    inner = `<polygon points="${cx},${cy-r*0.65} ${cx+r*0.65},${cy} ${cx},${cy+r*0.65} ${cx-r*0.65},${cy}" fill="none" stroke="${hslMain}" stroke-width="1.5"/>`;
  } else if (shape === 2) {
    // Triangle
    const pts = [0,1,2].map(i => {
      const a = (Math.PI * 2 / 3) * i - Math.PI / 2;
      return `${cx + r*0.7*Math.cos(a)},${cy + r*0.7*Math.sin(a)}`;
    }).join(' ');
    inner = `<polygon points="${pts}" fill="none" stroke="${hslMain}" stroke-width="1.5"/>`;
  } else {
    // Circle + cross
    inner = `<circle cx="${cx}" cy="${cy}" r="${r*0.6}" fill="none" stroke="${hslMain}" stroke-width="1.5"/>
             <line x1="${cx}" y1="${cy-r*0.55}" x2="${cx}" y2="${cy+r*0.55}" stroke="${hslMain}" stroke-width="1"/>
             <line x1="${cx-r*0.55}" y1="${cy}" x2="${cx+r*0.55}" y2="${cy}" stroke="${hslMain}" stroke-width="1"/>`;
  }

  const dotR = r * 0.2 + (bytes[3] % 8);
  const dot  = `<circle cx="${cx}" cy="${cy}" r="${Math.min(dotR, r*0.3)}" fill="${hslMain}" opacity="0.7"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${hslDark}"/>
    ${inner}
    ${dot}
  </svg>`;
}

// ── gRPC Client ───────────────────────────────────────────────

let _rnodeClient = null;

function getRnodeClient(shardUrl = DEFAULT_SHARD_URL) {
  if (!_rnodeClient) {
    // @tgrospic/rnode-grpc-js initialisation
    _rnodeClient = rnodeProtobuf({ grpcLib: null, host: shardUrl });
  }
  return _rnodeClient;
}

// ── Deploy Helper ─────────────────────────────────────────────

/**
 * Deploy a rholang term and optionally propose.
 * Returns the deploy result.
 */
export async function deploy(rhoTerm, privateKeyHex, opts = {}) {
  const {
    phloLimit       = PHLO_LIMIT,
    phloPrice       = PHLO_PRICE,
    validAfterBlock = VALID_AFTER_BLOCK,
    shardId         = 'root',
    propose         = false,
  } = opts;

  const client = getRnodeClient(opts.shardUrl);

  const deployData = getDeployData({
    term:           rhoTerm,
    timestamp:      Date.now(),
    phloPrice,
    phloLimit,
    validAfterBlockNumber: validAfterBlock,
    shardId,
  });

  const signed = signDeploy(privateKeyHex, deployData);

  const { DeployService } = client;
  const result = await DeployService.doDeploy(signed);

  if (propose) {
    const { ProposeService } = getRnodeClient(opts.proposeUrl || PROPOSE_SHARD_URL);
    await ProposeService.propose({});
  }

  return result;
}

// ── Registry Lookup ───────────────────────────────────────────

/**
 * Look up a channel by registry URI and read the first message.
 */
export async function registryLookup(uri, shardUrl = DEFAULT_SHARD_URL) {
  const term = `
    new lookup(\`rho:registry:lookup\`), ch in {
      lookup!(\`${uri}\`, *ch) |
      for (@contract <- ch) {
        @"__result__"!(contract)
      }
    }
  `;
  const client = getRnodeClient(shardUrl);
  const result = await client.DeployService.exploreDeploy({ term });
  return extractResult(result);
}

// ── Contract Interaction ──────────────────────────────────────

/**
 * Call a contract method and read the ack value.
 * Uses exploreDeploy (read-only) for queries.
 */
export async function queryContract(uri, method, args, shardUrl = DEFAULT_SHARD_URL) {
  const argStr = args.map(a => JSON.stringify(a)).join(', ');
  const term   = `
    new lookup(\`rho:registry:lookup\`), ch, ack in {
      lookup!(\`${uri}\`, *ch) |
      for (@contract <- ch) {
        @contract!("${method}", ${argStr}, *ack) |
        for (@result <- ack) {
          @"__result__"!(result)
        }
      }
    }
  `;
  const client = getRnodeClient(shardUrl);
  const result = await client.DeployService.exploreDeploy({ term });
  return extractResult(result);
}

/**
 * Call a contract method that mutates state (sends a deploy).
 */
export async function sendToContract(uri, method, args, privateKeyHex, opts = {}) {
  const argStr = args.map(a => rhoLiteral(a)).join(', ');
  const term   = `
    new lookup(\`rho:registry:lookup\`), ch, ack in {
      lookup!(\`${uri}\`, *ch) |
      for (@contract <- ch) {
        @contract!("${method}", ${argStr}, *ack) |
        for (@result <- ack) {
          @"__ack__"!(result)
        }
      }
    }
  `;
  return deploy(term, privateKeyHex, { ...opts, propose: true });
}

// ── High-Level API ────────────────────────────────────────────

// -- Stories --

export async function createStory({ storyId, title, authorPub, treasury, aiPersona, aiPersonaSpec }, privateKeyHex) {
  const id = storyId || `story_${uuidv4().replace(/-/g,'')}`;
  return sendToContract(
    REGISTRY_URIS.storyRegistry, 'createStory',
    [id, title, authorPub, treasury, aiPersona, aiPersonaSpec],
    privateKeyHex
  );
}

export async function getStory(storyId) {
  return queryContract(REGISTRY_URIS.storyRegistry, 'get', [storyId]);
}

// -- Arcs --

export async function createArc({ storyId, arcId, arcTitle, beatTarget, charSlots, split }, privateKeyHex) {
  const id = arcId || `arc_${uuidv4().replace(/-/g,'')}`;
  return sendToContract(
    REGISTRY_URIS.storyRegistry, 'createArc',
    [storyId, id, arcTitle, beatTarget, charSlots, split],
    privateKeyHex
  );
}

export async function stakeDriver({ arcId, charName, driverPub, stakeAmount, fromRevAddr }, privateKeyHex) {
  return sendToContract(
    REGISTRY_URIS.storyRegistry, 'stakeDriver',
    [arcId, charName, driverPub, stakeAmount, fromRevAddr],
    privateKeyHex
  );
}

// -- Beats --

export async function submitBeat({ arcId, authorType, authorPub, charName, content }, privateKeyHex) {
  const beatId     = `beat_${uuidv4().replace(/-/g,'')}`;
  const contentHash = await sha256hex(content);
  return sendToContract(
    REGISTRY_URIS.storyRegistry, 'submitBeat',
    [arcId, beatId, authorType, authorPub, charName, content, contentHash],
    privateKeyHex
  );
}

export async function applandBeat(beatId, privateKeyHex) {
  return sendToContract(REGISTRY_URIS.storyRegistry, 'applandBeat', [beatId], privateKeyHex);
}

export async function tipBeat({ beatId, tipAmount, fromRevAddr }, privateKeyHex) {
  return sendToContract(
    REGISTRY_URIS.storyRegistry, 'tipBeat',
    [beatId, tipAmount, fromRevAddr],
    privateKeyHex
  );
}

// -- Kibitz --

export async function postKibitz({ beatId, storyId, authorPub, content, anchor, isWhatIf }, privateKeyHex) {
  const kibitzId = `kibitz_${uuidv4().replace(/-/g,'')}`;
  return sendToContract(
    REGISTRY_URIS.kibitzRegistry, 'post',
    [kibitzId, beatId, storyId, authorPub, content, anchor, isWhatIf],
    privateKeyHex
  );
}

export async function voteKibitz(kibitzId, direction, privateKeyHex) {
  return sendToContract(REGISTRY_URIS.kibitzRegistry, 'vote', [kibitzId, direction], privateKeyHex);
}

export async function tipKibitz({ kibitzId, tipAmount, fromRevAddr }, privateKeyHex) {
  return sendToContract(
    REGISTRY_URIS.kibitzRegistry, 'tip',
    [kibitzId, tipAmount, fromRevAddr],
    privateKeyHex
  );
}

// -- Meta-Proposals --

export async function submitMetaProposal({
  storyId, proposerPub, stake, title, arcAffected, changeType, justification, fromRevAddr
}, privateKeyHex) {
  const proposalId = `prop_${uuidv4().replace(/-/g,'')}`;
  return sendToContract(
    REGISTRY_URIS.metaProposalRegistry, 'propose',
    [proposalId, storyId, proposerPub, stake, title, arcAffected, changeType, justification, fromRevAddr],
    privateKeyHex
  );
}

export async function decideMetaProposal({ proposalId, authorPub, accept }, privateKeyHex) {
  return sendToContract(
    REGISTRY_URIS.metaProposalRegistry, 'decide',
    [proposalId, authorPub, accept],
    privateKeyHex
  );
}

// -- Personas --

export async function createPersona({ personaId, name, ownerPub, storyId, specHash, specSummary, model }, privateKeyHex) {
  const id = personaId || `persona_${uuidv4().replace(/-/g,'')}`;
  return sendToContract(
    REGISTRY_URIS.personaRegistry, 'create',
    [id, name, ownerPub, storyId, specHash, specSummary, model],
    privateKeyHex
  );
}

// ── RevVault Balance Query ─────────────────────────────────────

export async function getBalance(revAddress, shardUrl = DEFAULT_SHARD_URL) {
  const term = `
    new vaultCh, balanceCh, revVault(\`rho:rchain:revVault\`) in {
      revVault!("findOrCreate", "${revAddress}", *vaultCh) |
      for(@(_, vault) <- vaultCh) {
        @vault!("balance", *balanceCh) |
        for(@balance <- balanceCh) {
          @"__result__"!(balance)
        }
      }
    }
  `;
  const client = getRnodeClient(shardUrl);
  const result = await client.DeployService.exploreDeploy({ term });
  return extractResult(result);
}

// ── Utilities ─────────────────────────────────────────────────

function extractResult(exploreDeploy) {
  try {
    const expr = exploreDeploy?.expr?.[0];
    if (!expr) return null;
    // Walk the rholang Par/Expr tree returned by the node
    if (expr.ExprString)  return expr.ExprString.data;
    if (expr.ExprInt)     return expr.ExprInt.data;
    if (expr.ExprBool)    return expr.ExprBool.data;
    if (expr.ExprMap)     return rhoMapToObj(expr.ExprMap);
    return expr;
  } catch (e) {
    return null;
  }
}

function rhoMapToObj(exprMap) {
  const obj = {};
  for (const [k, v] of Object.entries(exprMap.ps || {})) {
    obj[k] = extractResult({ expr: [v] });
  }
  return obj;
}

function rhoLiteral(v) {
  if (typeof v === 'string')  return `"${v.replace(/"/g, '\\"')}"`;
  if (typeof v === 'number')  return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null)             return 'Nil';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const pairs = Object.entries(v).map(([k,val]) => `"${k}": ${rhoLiteral(val)}`).join(', ');
    return `{${pairs}}`;
  }
  return JSON.stringify(v);
}

function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2)
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bytesToBase58(bytes) {
  let n = BigInt('0x' + bytes.map(b => b.toString(16).padStart(2,'0')).join(''));
  let result = '';
  const base = BigInt(58);
  while (n > 0n) {
    result = BASE58_ALPHABET[Number(n % base)] + result;
    n = n / base;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result = '1' + result;
  }
  return result;
}

async function sha256hex(str) {
  const msgBuffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  generateIdentity,
  restoreIdentity,
  pubKeyToSigilSVG,
  createStory,
  getStory,
  createArc,
  stakeDriver,
  submitBeat,
  applandBeat,
  tipBeat,
  postKibitz,
  voteKibitz,
  tipKibitz,
  submitMetaProposal,
  decideMetaProposal,
  createPersona,
  getBalance,
  deploy,
  queryContract,
  sendToContract,
};
