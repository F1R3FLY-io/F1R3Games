# F1R3SideChat — Game Design Document
### A F1R3FLY Collaborative Storytelling Game
**Version 0.1 · March 2026 · Confidential**

---

## 1. Vision

F1R3SideChat is a live, layered collaborative fiction platform where **AI and human co-authors** spin ongoing serial narratives while a readership watches, comments, tips, and — if they spend tokens — joins the story itself. It is one node in the F1R3Games constellation, sharing the same shard-native cryptographic identity (ECDSA P-256 keypairs), F1R3Cap token economy, and sigil avatar system.

The name nods to the "side chat" that happens whenever an audience watches a performance: the whisper network, the kibitz, the unexpected voice that steps out of the crowd and onto the stage.

---

## 2. Core Design Principles

1. **Reading is the primary experience.** Most participants never spend a token. They arrive for a great story. Everything else is optional depth.
2. **Participation is a spectrum, not a binary.** The arc from reader → kibitzer → character driver → meta-author is smooth, priced, and reversible.
3. **Applause is the primary reward.** Token tipping is layered on top but is never the only feedback signal. Emoji reactions, applause counts, and reader-following are free.
4. **The AI is a character in the room.** The AI co-author is not a hidden engine; it is a named participant in the meta-narrative layer, visible and addressable.
5. **Shard-native identity.** No email, no password. A keypair is the identity. The chain is the record.

---

## 3. Participation Tiers

### Tier 0 — Reader (free, no account required)
- Read published story threads in full.
- See the live feed of story updates in real time.
- React with a fixed emoji palette (🔥 ❤️ 😱 👁️ 🌀).
- Subscribe to story threads for push updates (requires keypair registration, still free).

### Tier 1 — Kibitzer (free, keypair required)
The kibitz rail is a parallel annotation layer rendered beside or beneath the story text. It is the "side chat" of the name.

- Leave inline comments anchored to specific story beats.
- Suggest alternative lines or plot moves ("what if…" cards).
- Vote on others' suggestions (thumbs up/down, also free).
- Receive tips from readers who loved a kibitz note.

The kibitz rail is *not* the story. It is typographically distinct (smaller, lower contrast, indented) and can be hidden by any reader with a toggle.

### Tier 2 — Character Driver (token cost: moderate)
A Character Driver **takes the wheel** of a named secondary or tertiary character for the duration of a story arc (a defined sequence of beats). 

- Costs a per-arc token stake, priced by the story owner.
- The driver writes dialogue and action beats for their character; the AI co-author integrates them into the narrative fabric and may reject incoherent submissions (with explanation).
- The driver's identity sigil appears inline next to their character's name in the published text.
- Drivers may be applauded or tipped by readers for particularly good moments.
- A driver who goes idle forfeits their stake; the AI resumes the character.

**Key constraint:** Character Drivers cannot alter the primary narrative arc. They steer *within* the lane set by the story's author and AI. This is enforced at the submission layer.

### Tier 3 — Meta-Author Dialogue (token cost: substantial)
The highest tier grants access to the **meta-meta-narrative layer** — the explicit conversation between the human author(s), the AI co-author, and the story's structural logic.

- Participants can propose **arc-level changes**: new characters, plot pivots, tonal shifts, world-building additions.
- These proposals enter a structured deliberation queue; the author and AI discuss them in public (the deliberation is itself readable by all, at no cost).
- Accepted proposals become part of the official story canon and are credited to the proposing Meta-Author.
- Meta-Authors are listed in the story's credits/provenance record on-shard.
- Cost is a flat stake per proposal, with a higher recurring cost for sustained "writer's room" access across multiple sessions.

---

## 4. Token Economy

All transactions use **F1R3Cap** tokens on the F1R3FLY shard. Identity is a P-256 keypair; balances live at the key's revVault address.

### Earning Tokens
| Action | Mechanism |
|---|---|
| Reader tips a Kibitz note | Direct revVault transfer to kibitzer |
| Reader tips a Character Driver moment | Direct transfer to driver |
| Proposal accepted by author (Meta-Author) | Bounty from story treasury + reader tips |
| High-applause story thread | Author earns from reader tip pool |

### Spending Tokens
| Action | Cost Model |
|---|---|
| Character Driver stake | Per-arc flat rate, set by story owner |
| Meta-Author proposal | Per-proposal flat stake |
| Writer's Room subscription | Recurring per-session stake |

### Story Treasury
Each story thread has a **treasury address** (a channel on-shard). Readers who love the story may tip the treasury directly. The author distributes treasury earnings at arc completion according to a pre-declared split: author %, AI %, character drivers %, tip-back to top kibitzers %.

### Free Actions (never cost tokens)
- Reading
- Reactions
- Kibitz comments
- Voting on suggestions
- Subscribing to threads

---

## 5. Narrative Structure

### Story Thread
The atomic unit. A thread has:
- A **title** and **world** (setting, tone, genre tags)
- An **author** (human keypair, the "showrunner")
- One or more **AI co-author** personas (named, with personality descriptors)
- A sequence of **arcs**, each with defined character slots, a beat count target, and an open/closed Driver status

### Beat
A single narrative unit: a paragraph or short scene, typically 80–400 words. Beats are the granular append-only record on the shard. Each beat carries:
- Author type (human, AI, character driver)
- Timestamp + block reference
- Kibitz anchor points
- Applause counter

### Arc
A collection of beats forming a self-contained episode. Arcs have a declared character roster; drivers must be staked before the arc opens.

### Meta-Narrative Log
A separate thread attached to the story, recording all Meta-Author deliberation. This log is public, readable for free, and constitutes the "making-of" documentary of the story.

---

## 6. The Victoria & Balthazar Template

The Victoria & Balthazar mystery series demonstrates the model in its natural habitat:

- **Victoria** and **Balthazar** are the primary characters, owned by the human author and the AI co-author respectively (or jointly).
- Secondary characters (suspects, witnesses, antagonists) are available as **Character Driver slots** per arc.
- The **mystery structure** is set in the meta-narrative layer: the author and AI agree on the culprit, the clues, and the red herrings before the arc opens. Character Drivers cannot break the mystery's internal logic.
- Kibitzers can post "theory threads" visible in the kibitz rail — these become part of the reading pleasure.
- Meta-Authors can pitch **sequel arcs**, **prequels**, **spin-off characters**, or **alternate endings** (clearly marked as non-canonical unless accepted).

---

## 7. Identity & Sigils

F1R3SideChat uses the same cryptographic identity system as the rest of F1R3Games:

- Identity = ECDSA P-256 keypair (generated client-side, no server custody)
- Display name is human-chosen and mutable; keypair is permanent
- **Sigil avatar** is deterministically generated from the public key using the shared F1R3Games geometric generation algorithm
- Sigils appear inline in story text next to character driver attributions and in kibitz threads

No email, no password, no OAuth. A participant who loses their keypair loses their identity; this is by design and is clearly communicated onboarding.

---

## 8. Relationship to F1R3Sky

F1R3Sky is the F1R3FLY fork of the Bluesky social app (React Native / TypeScript, built on the AT Protocol). F1R3SideChat's **social layer** — following authors, sharing story threads, applauding beats — can be surfaced through F1R3Sky's feed infrastructure. Story threads are AT Protocol records; beats are lexicon-typed posts. The kibitz rail maps naturally to AT Protocol reply threading.

This means F1R3SideChat stories are **natively shareable** on any AT Protocol client, while the token-gated participation layers are F1R3FLY-specific.

Key architectural connections:
- Story beats → `app.f1r3fly.sidechat.beat` lexicon records
- Kibitz comments → standard AT Protocol replies with `f1r3sidechat.kibitz` label
- Applause → AT Protocol likes
- Character driver attribution → embedded keypair sigil in beat record
- Token staking / treasury → F1R3FLY shard channels (not AT Protocol)

---

## 9. On-Shard Data Model (Sketch)

```
story_thread_key : {
  title       : String
  author_pub  : PubKey
  treasury    : RevVaultAddr
  arcs        : List[ArcRef]
}

arc_key : {
  story       : StoryRef
  beat_count  : Int
  char_slots  : Map[CharName, Option[PubKey]]  // None = AI-driven
  status      : Open | Closed | Complete
  split       : SplitSpec
}

beat_key : {
  arc         : ArcRef
  seq         : Int
  author_type : Human | AI | Driver(PubKey)
  content     : ContentHash  // content stored off-shard, hash on-shard
  timestamp   : BlockRef
  applause    : Int
}

kibitz_key : {
  beat        : BeatRef
  anchor      : CharOffset
  author      : PubKey
  content     : String
  tips_recv   : RevAmount
}

meta_proposal_key : {
  story       : StoryRef
  proposer    : PubKey
  stake       : RevAmount
  proposal    : ContentHash
  status      : Pending | Accepted | Rejected
}
```

---

## 10. UX Sketch

### Primary Feed (Reader)
Dark terminal-aesthetic canvas. Story beats scroll in order, typeset in a clean serif for narrative text. Kibitz annotations appear in a dimmer monospace rail to the right (collapsible). Sigil icons glow faintly next to character-driver beats.

### Kibitz Rail
Monospace, lower contrast, neon accent on hover. "What if…" suggestion cards have a distinct treatment (dashed border, italic). Voting buttons are minimal — just counts.

### Character Driver Console
A constrained text editor with the character's voice guide visible. Beat submission triggers a brief AI integration review (a few seconds). If accepted, the beat animates into the main thread. If the AI suggests a revision, a dialogue opens.

### Meta-Author Deliberation Room
A structured threaded conversation between the proposer, the human author, and the AI persona. Style is closer to a design review than a chat — proposals have structured fields (arc affected, change type, narrative justification). The deliberation log is public; the vote is private (author only).

---

## 11. Moderation & Safety

- Story threads are author-moderated by default; the author can mute or eject Character Drivers.
- Kibitz comments can be hidden by the author or by the reader individually.
- F1R3FLY platform-level moderation applies to all content.
- AI co-author acts as a soft guardrail on Character Driver submissions (incoherent or abusive beats are flagged before publication).
- Meta-Author proposals that violate story tone or platform rules are rejected at the deliberation stage.

---

## 12. Open Questions

1. **AI persona ownership** — Is the AI co-author a single platform persona or can authors configure/name their own AI persona per story? (Recommendation: configurable, with the AI persona's "personality spec" stored as a meta-narrative record on-shard.)
2. **Forking stories** — Should completed arcs be forkable by other authors? What are the canonical/non-canonical rules? (Recommendation: yes, with full attribution chain on-shard.)
3. **Token pricing calibration** — Character Driver stakes and Meta-Author proposal costs need playtesting. Initial recommendation: Driver stake = 10 F1R3Cap / arc; Meta-Author proposal = 50 F1R3Cap; Writer's Room = 200 F1R3Cap / session.
4. **Offline reading** — Should story threads be downloadable as epub/PDF at arc completion? (Recommendation: yes, as a free export, good for word-of-mouth.)
5. **F1R3Sky integration depth** — Which features live natively in the F1R3Sky app vs. in a standalone F1R3SideChat app? (Recommendation: reading and kibitz in F1R3Sky; Driver and Meta-Author consoles in dedicated app or deep-link web UI.)

---

*Document prepared by Meredith, CEO F1R3FLY · with Claude · March 2026*
