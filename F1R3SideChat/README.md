# F1R3SideChat

**Collaborative storytelling game in the F1R3Games suite.**  
AI and human co-authors spin serial narratives on the F1R3FLY shard; a readership watches, reacts, kibitz-comments, and — for tokens — joins the story itself.

---

## Structure

```
F1R3SideChat/
├── index.html               # Full UI — self-contained, open in browser
├── package.json
├── src/
│   └── shardClient.js       # F1R3FLY shard integration (gRPC via @tgrospic/rnode-grpc-js)
└── contracts/
    ├── f1r3sidechat_core.rho    # Story registry, arcs, beats, kibitz, meta-proposals
    └── f1r3sidechat_persona.rho # AI persona registry
```

---

## Participation Tiers

| Tier | Name | Cost | What you can do |
|---|---|---|---|
| 0 | Reader | Free | Read stories, see kibitz rail |
| 1 | Kibitzer | Free (keypair required) | Comment on beats, post "what if…" cards, vote, receive tips |
| 2 | Character Driver | 10 F1R3Cap / arc | Stake to drive a named character; write their dialogue & actions |
| 3 | Meta-Author | 50 F1R3Cap / proposal | Propose arc-level changes; enter deliberation with author + AI |

---

## Identity

F1R3SideChat uses the same identity model as all F1R3Games:

- Identity = **ECDSA P-256 keypair** (generated client-side, no server)
- **Sigil avatar** is deterministically derived from the public key
- Balance lives in a **revVault** on the F1R3FLY shard
- No email, no password, no OAuth

---

## Shard Contracts

### `f1r3sidechat_core.rho`

Exports three registry channels:

| Channel | URI | Purpose |
|---|---|---|
| `storyRegistry` | `rho:id:f1r3sidechat:storyRegistry` | Stories, arcs, beats, applause, tips |
| `kibitzRegistry` | `rho:id:f1r3sidechat:kibitzRegistry` | Kibitz notes, votes, tips |
| `metaProposalRegistry` | `rho:id:f1r3sidechat:metaProposalRegistry` | Meta-author proposals and decisions |

Key contract operations:

```
storyRegistry  ! ("createStory",   storyId, title, authorPub, treasury, aiPersona, aiPersonaSpec, ack)
storyRegistry  ! ("createArc",     storyId, arcId, arcTitle, beatTarget, charSlots, split, ack)
storyRegistry  ! ("stakeDriver",   arcId, charName, driverPub, stakeAmount, fromRevAddr, ack)
storyRegistry  ! ("submitBeat",    arcId, beatId, authorType, authorPub, charName, content, hash, ack)
storyRegistry  ! ("applandBeat",   beatId, ack)
storyRegistry  ! ("tipBeat",       beatId, tipAmount, fromRevAddr, ack)

kibitzRegistry ! ("post",          kibitzId, beatId, storyId, authorPub, content, anchor, isWhatIf, ack)
kibitzRegistry ! ("vote",          kibitzId, direction, ack)
kibitzRegistry ! ("tip",           kibitzId, tipAmount, fromRevAddr, ack)

metaProposalRegistry ! ("propose", proposalId, storyId, proposerPub, stake, title, arcAffected, changeType, justification, fromRevAddr, ack)
metaProposalRegistry ! ("decide",  proposalId, authorPub, accept, ack)
```

### `f1r3sidechat_persona.rho`

```
personaRegistry ! ("create",         personaId, name, ownerPub, storyId, specHash, specSummary, model, ack)
personaRegistry ! ("updateSpec",      personaId, newSpecHash, newSpecSummary, callerPub, ack)
personaRegistry ! ("incrementBeatCount", personaId, ack)
```

---

## Shard Client (`src/shardClient.js`)

High-level JS API wrapping `@tgrospic/rnode-grpc-js`:

```js
import shardClient from './src/shardClient.js';

// Generate or restore identity
const id = shardClient.generateIdentity();
// → { privateKeyHex, publicKeyHex, revAddress }

// Check balance
const bal = await shardClient.getBalance(id.revAddress);

// Create a story
await shardClient.createStory({
  title:        'The Whitmore Murders',
  authorPub:    id.publicKeyHex,
  treasury:     id.revAddress,
  aiPersona:    'Cassiel',
  aiPersonaSpec: hash,
}, id.privateKeyHex);

// Post a beat
await shardClient.submitBeat({
  arcId:      'arc_001',
  authorType: 'human',
  authorPub:  id.publicKeyHex,
  charName:   null,
  content:    'Victoria found the second glove at half past midnight…',
}, id.privateKeyHex);

// Post kibitz
await shardClient.postKibitz({
  beatId:    'beat_001',
  storyId:   'story_001',
  authorPub: id.publicKeyHex,
  content:   'What if the cufflinks belong to her brother?',
  anchor:    '"The pattern is a maker\'s mark"',
  isWhatIf:  true,
}, id.privateKeyHex);
```

---

## Running Locally

```bash
# Open the UI directly (no build needed for demo)
open index.html

# Or run with Vite for production build
npm install
npm run dev
```

For full shard integration, run a local F1R3FLY node:

```bash
docker compose -f docker/shard-with-autopropose.yml up
```

Then deploy the contracts:

```bash
# Using rnode CLI or the F1R3FLY deploy tool
rnode deploy --phlo-limit 1000000 contracts/f1r3sidechat_core.rho
rnode deploy --phlo-limit 1000000 contracts/f1r3sidechat_persona.rho
rnode propose
```

Update `DEFAULT_SHARD_URL` in `src/shardClient.js` to point at your node.

---

## F1R3Sky Integration

Story beats are designed to map to AT Protocol lexicon records
(`app.f1r3fly.sidechat.beat`), enabling native sharing on any
Bluesky-compatible client via the F1R3Sky fork. Token-gated tiers
remain F1R3FLY-shard-specific; reading and reactions federate freely.

---

## Token Economics (Quick Reference)

| Action | Cost | Direction |
|---|---|---|
| Read / react | Free | — |
| Kibitz comment | Free | — |
| Character Driver stake | 10 F1R3Cap | → story treasury |
| Meta-Author proposal | 50 F1R3Cap | → story treasury |
| Writer's Room subscription | 200 F1R3Cap / session | → story treasury |
| Tip a beat | Variable | → beat author revVault |
| Tip a kibitz note | Variable | → kibitz author revVault |
| Arc completion payout | From treasury | → split per spec |

*Default split spec: Author 40% · AI 10% · Drivers 35% · Top kibitzers 15%*

---

*F1R3FLY · Concurrency for the People*
