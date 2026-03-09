import { useState, useEffect, useCallback, useRef, useMemo, useReducer } from "react";

// ═══════════════════════════════════════════════════════════════════
// F1R3SideChat — Collective Intelligence Collaborative Storytelling
//
// Two user classes:
//   CONSUMER — reads stories, leaves comments (free)
//   CREATOR  — authors story content, drives characters
//
// Transitions:
//   Consumer -> Creator: "Take the wheel" on a character (costs tokens)
//   Creator engagement with AI co-author: costs substantially more tokens
//
// Rewards:
//   Creators earn reputation through reader applause (upvotes)
//   Anyone can tip contributions
//
// All state lives on the F1R3FLY shard.
// ═══════════════════════════════════════════════════════════════════

// ─── Shard Mock ────────────────────────────────────────────────────
const SHARD = { token: "F1R3Cap", grpcHost: "localhost", grpcExternal: 40401 };
const shard = {
  connected: false,
  async connect() { this.connected = true; return true; },
  async deploy(rho) { return { ok: true, id: `d-${Date.now()}` }; },
};

// ─── Token Costs ───────────────────────────────────────────────────
const COSTS = {
  TAKE_WHEEL:    100,  // Consumer -> Creator for a character
  AI_COAUTHOR:   500,  // Engage AI to help write
  TALK_TO_AUTHOR: 250, // Direct conversation with story author
  TIP_MIN:        10,  // Minimum tip
};

// ─── Mock Story Data ───────────────────────────────────────────────
const STORY = {
  id: "story-001",
  title: "The Cartographer of Lost Rivers",
  genre: "Mystery / Fantasy",
  author: { id: "p2", name: "Aria", emoji: "🌊", color: "#3FA9F5" },
  synopsis: "In a city where rivers have been paved over and forgotten, a blind cartographer discovers she can hear the water still flowing beneath the streets. When buildings begin to collapse into the hidden waterways, she must map the invisible rivers before the city drowns from below.",
  chapters: [
    {
      id: "ch1", num: 1, title: "The Sound Beneath Concrete",
      author: "p2", status: "published",
      text: `The first time Maren heard the river, she thought it was rain.\n\nShe was standing at the corner of Ash Street and Viaduct, her white cane tapping the familiar rhythm against the curb. The city hummed its usual frequencies — diesel idling, a busker's violin two blocks east, the staccato of heels on the pedestrian bridge above. But underneath all of it, threading through the concrete like a whispered secret, was the sound of moving water.\n\nNot storm drains. Not burst pipes. This was older. Deeper. A current that remembered being a river.\n\n"You hear that?" she asked the dog. Sable's ears perked, but the guide dog gave no indication of alarm. Water was water. But Maren's hands were trembling on the harness.\n\nShe had been blind since she was nine — long enough to have rebuilt her entire map of the world in sound and texture. She knew this intersection by its acoustic signature the way sighted people knew it by its traffic light. And this sound did not belong here.\n\nShe knelt, pressing her palm flat against the sidewalk. The vibration was unmistakable. Something was flowing, six feet below her fingers, in a direction that no municipal map acknowledged.`,
      wordCount: 198,
      applause: 47,
    },
    {
      id: "ch2", num: 2, title: "The Archive of Buried Channels",
      author: "p2", status: "published",
      text: `The Historical Society occupied the top floor of a building that should have been condemned. Maren climbed the stairs by counting — forty-two steps, a landing that smelled of mildewed carpet, then twenty more steps to a door that stuck in its frame.\n\n"I need your oldest maps," she told the archivist, a man whose voice suggested tweed and resignation. "The ones from before the city paved the rivers."\n\nA silence. Then the scrape of a chair.\n\n"No one has asked for those in years," he said. "They're in the basement. Which is ironic, given what's down there."\n\nHe meant it as a joke. But when they descended and Maren pressed her hand to the basement wall, she felt it — the thrum of a current so close it seemed to push against the foundation stones. The archivist didn't notice. People who could see rarely listened to buildings.`,
      wordCount: 156,
      applause: 32,
    },
    {
      id: "ch3", num: 3, title: "Cracks in the Foundation",
      author: null, status: "open",
      text: "",
      wordCount: 0,
      applause: 0,
    },
  ],
  characters: [
    { id: "maren",    name: "Maren",         role: "Protagonist — blind cartographer", driver: "p2",  color: "#F3D630", icon: "🗺️" },
    { id: "sable",    name: "Sable",          role: "Maren's guide dog",                driver: null,  color: "#8B7355", icon: "🐕" },
    { id: "archivist",name: "The Archivist",  role: "Keeper of forgotten maps",         driver: "p5",  color: "#6B8E6B", icon: "📚" },
    { id: "river",    name: "The River",      role: "The buried consciousness",          driver: null,  color: "#3FA9F5", icon: "🌊" },
    { id: "mayor",    name: "Mayor Calloway", role: "Wants the rivers to stay hidden",   driver: null,  color: "#CC4444", icon: "🏛️" },
  ],
  readers: 234,
  comments: [
    { id: 1, user: { id: "p3", name: "Kael", emoji: "⚡" }, chapterId: "ch1", text: "The acoustic mapping premise is brilliant. I love that her blindness isn't a limitation — it's her superpower.", ts: Date.now() - 300000, applause: 12 },
    { id: 2, user: { id: "p6", name: "Onyx", emoji: "🌑" }, chapterId: "ch1", text: "The detail about knowing an intersection by its acoustic signature... that's the kind of world-building that makes you stop and re-read.", ts: Date.now() - 180000, applause: 8 },
    { id: 3, user: { id: "p4", name: "Nova", emoji: "🌸" }, chapterId: "ch2", text: "\"People who could see rarely listened to buildings.\" — This line. This is the whole thesis of the story.", ts: Date.now() - 60000, applause: 23 },
  ],
};

const PLAYERS = [
  { id: "p1", name: "You",   emoji: "🔥", color: "#ff4d2d", role: "consumer", addr: "1111aaaa" },
  { id: "p2", name: "Aria",  emoji: "🌊", color: "#3FA9F5", role: "creator",  addr: "2222bbbb" },
  { id: "p3", name: "Kael",  emoji: "⚡", color: "#F3D630", role: "consumer", addr: "3333cccc" },
  { id: "p4", name: "Nova",  emoji: "🌸", color: "#ff2d8c", role: "consumer", addr: "4444dddd" },
  { id: "p5", name: "Zeph",  emoji: "🍃", color: "#2dff8c", role: "creator",  addr: "5555eeee" },
  { id: "p6", name: "Onyx",  emoji: "🌑", color: "#b82dff", role: "consumer", addr: "6666ffff" },
];

// ─── State ─────────────────────────────────────────────────────────
const INIT = {
  bal: 1000,
  role: "consumer",
  viewingChapter: "ch1",
  comments: STORY.comments,
  txs: [],
  msgs: [],
  shardStatus: "off",
  pend: [],
  drivingCharacter: null,
  showAIPanel: false,
  aiMessages: [],
};

function reducer(s, a) {
  switch (a.type) {
    case "VIEW_CH": return { ...s, viewingChapter: a.id };
    case "COMMENT": return { ...s, comments: [...s.comments, a.c] };
    case "APPLAUD": return { ...s, comments: s.comments.map(c => c.id === a.id ? { ...c, applause: c.applause + 1 } : c) };
    case "TX": return { ...s, txs: [...s.txs, a.tx], bal: s.bal - a.tx.amt };
    case "TAKE_WHEEL": return { ...s, role: "creator", drivingCharacter: a.charId, bal: s.bal - COSTS.TAKE_WHEEL };
    case "SH": return { ...s, shardStatus: a.v };
    case "SHOW_AI": return { ...s, showAIPanel: true, bal: s.bal - COSTS.AI_COAUTHOR };
    case "AI_MSG": return { ...s, aiMessages: [...s.aiMessages, a.m] };
    case "MSG": return { ...s, msgs: [...s.msgs, a.m] };
    default: return s;
  }
}

// ─── Subcomponents ─────────────────────────────────────────────────

function ChapterNav({ chapters, current, onSelect }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {chapters.map(ch => {
        const sel = ch.id === current;
        const isOpen = ch.status === "open";
        return (
          <button key={ch.id} onClick={() => onSelect(ch.id)} style={{
            display: "flex", alignItems: "baseline", gap: 8, padding: "8px 10px",
            borderRadius: 6, textAlign: "left", cursor: "pointer",
            background: sel ? "#1a150e" : "transparent",
            border: sel ? "1px solid #33281a" : "1px solid transparent",
            transition: "all .2s", fontFamily: "'Crimson Pro', serif",
          }}>
            <span style={{ fontSize: 11, color: "#665533", fontFamily: "'IBM Plex Mono', monospace",
              minWidth: 22 }}>{ch.num}.</span>
            <div>
              <div style={{ fontSize: 13, color: sel ? "#d4c4a8" : "#887755",
                fontWeight: sel ? 600 : 400 }}>{ch.title}</div>
              {isOpen && <div style={{ fontSize: 9, color: "#F3D630", marginTop: 2,
                fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 1 }}>OPEN FOR WRITING</div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function CharacterCard({ char, isMe, onTakeWheel, canAfford }) {
  const available = !char.driver;
  const driverPlayer = char.driver ? PLAYERS.find(p => p.id === char.driver) : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
      borderRadius: 6, background: "#0d0a0420",
      border: isMe ? `1px solid ${char.color}50` : "1px solid #1a150e" }}>
      <div style={{ fontSize: 18, width: 28, textAlign: "center" }}>{char.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: char.color,
          fontFamily: "'Crimson Pro', serif" }}>{char.name}</div>
        <div style={{ fontSize: 9, color: "#776644", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{char.role}</div>
        {driverPlayer && (
          <div style={{ fontSize: 9, color: driverPlayer.color, marginTop: 1 }}>
            Driven by {driverPlayer.emoji} {driverPlayer.name}
          </div>
        )}
      </div>
      {available && (
        <button onClick={() => onTakeWheel(char.id)} disabled={!canAfford} style={{
          padding: "3px 8px", borderRadius: 4, fontSize: 8,
          background: canAfford ? "#F3D63020" : "#1a150e",
          border: canAfford ? "1px solid #F3D630" : "1px solid #33281a",
          color: canAfford ? "#F3D630" : "#554422", cursor: canAfford ? "pointer" : "default",
          fontFamily: "'IBM Plex Mono', monospace", letterSpacing: .5, whiteSpace: "nowrap",
        }}>
          {COSTS.TAKE_WHEEL} ⚡ DRIVE
        </button>
      )}
    </div>
  );
}

function Comment({ c, onApplaud }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid #0d0a04", animation: "fadeUp .3s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 13 }}>{c.user.emoji}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#997755" }}>{c.user.name}</span>
        <span style={{ fontSize: 9, color: "#443320", marginLeft: "auto",
          fontFamily: "'IBM Plex Mono', monospace" }}>
          {Math.round((Date.now() - c.ts) / 60000)}m ago
        </span>
      </div>
      <div style={{ fontSize: 12, color: "#bba888", lineHeight: 1.5,
        fontFamily: "'Crimson Pro', serif" }}>{c.text}</div>
      <button onClick={() => onApplaud(c.id)} style={{
        marginTop: 4, padding: "2px 8px", borderRadius: 10, fontSize: 10,
        background: "transparent", border: "1px solid #33281a", color: "#776644",
        cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace",
      }}>
        👏 {c.applause}
      </button>
    </div>
  );
}

// ═══ MAIN ══════════════════════════════════════════════════════════
export default function F1R3SideChat() {
  const me = PLAYERS[0];
  const [s, d] = useReducer(reducer, INIT);
  const [newComment, setNewComment] = useState("");
  const [newStoryText, setNewStoryText] = useState("");
  const [tipAmt, setTipAmt] = useState("");
  const [tipTarget, setTipTarget] = useState(null);
  const [aiInput, setAiInput] = useState("");
  const commentEnd = useRef(null);

  const currentChapter = STORY.chapters.find(c => c.id === s.viewingChapter) || STORY.chapters[0];
  const chapterComments = s.comments.filter(c => c.chapterId === s.viewingChapter);
  const canWrite = s.role === "creator" && currentChapter.status === "open";

  useEffect(() => {
    d({ type: "SH", v: "connecting" });
    shard.connect().then(ok => d({ type: "SH", v: ok ? "on" : "off" }));
  }, []);

  useEffect(() => { commentEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [s.comments]);

  const doComment = useCallback(() => {
    if (!newComment.trim()) return;
    d({ type: "COMMENT", c: {
      id: Date.now(), user: me, chapterId: s.viewingChapter,
      text: newComment.trim(), ts: Date.now(), applause: 0,
    }});
    setNewComment("");
  }, [newComment, me, s.viewingChapter]);

  const doTakeWheel = useCallback((charId) => {
    if (s.bal < COSTS.TAKE_WHEEL) return;
    d({ type: "TAKE_WHEEL", charId });
  }, [s.bal]);

  const doTip = useCallback((targetId) => {
    const a = parseInt(tipAmt);
    if (!a || a < COSTS.TIP_MIN || a > s.bal) return;
    d({ type: "TX", tx: { id: Date.now(), from: me.id, to: targetId, amt: a, t: Date.now(), kind: "tip" } });
    setTipAmt(""); setTipTarget(null);
  }, [tipAmt, s.bal, me]);

  const doAICoauthor = useCallback(() => {
    if (s.bal < COSTS.AI_COAUTHOR) return;
    d({ type: "SHOW_AI" });
  }, [s.bal]);

  const doAISend = useCallback(() => {
    if (!aiInput.trim()) return;
    d({ type: "AI_MSG", m: { role: "user", text: aiInput.trim(), ts: Date.now() } });
    setAiInput("");
    // Mock AI response
    setTimeout(() => {
      d({ type: "AI_MSG", m: {
        role: "ai", ts: Date.now(),
        text: "The river's voice grew louder as Maren descended into the archive basement. Here, where the maps were oldest, the water seemed to press against the very walls — not threatening, but insistent. As if it had been waiting decades for someone to finally listen...",
      }});
    }, 1500);
  }, [aiInput]);

  const shC = { off: "#555", connecting: "#F3D630", on: "#2dff8c", err: "#ff4d2d" };

  return (
    <div style={{ width: "100%", height: "100vh", background: "#08060300",
      color: "#d4c4a8", fontFamily: "'Crimson Pro', 'Georgia', serif",
      display: "flex", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500&family=IBM+Plex+Mono:wght@300;400;500;600&family=Bebas+Neue&display=swap');
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes glow{0%,100%{text-shadow:0 0 8px #F3D63040}50%{text-shadow:0 0 16px #F3D63060}}
        .sc::-webkit-scrollbar{width:3px}.sc::-webkit-scrollbar-track{background:transparent}
        .sc::-webkit-scrollbar-thumb{background:#1a150e;border-radius:2px}
        input,textarea{font-family:'Crimson Pro','Georgia',serif}
        body{margin:0;background:#080603}
      `}</style>

      {/* ═══ LEFT: Story Nav / Characters / Tokens ═══ */}
      <div style={{ width: 260, minWidth: 260, background: "#0a080440",
        borderRight: "1px solid #1a150e", display: "flex", flexDirection: "column", padding: 14, gap: 12 }}>

        {/* Logo */}
        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, letterSpacing: 4,
          textAlign: "center", padding: "4px 0",
          background: "linear-gradient(135deg, #F3D630, #ff8c2d, #ff4d2d)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          F1R3SIDECHAT
        </div>

        {/* Shard + Role */}
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "5px 8px",
            background: "#0d0a04", borderRadius: 5, border: "1px solid #1a150e", fontSize: 9 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: shC[s.shardStatus],
              boxShadow: `0 0 4px ${shC[s.shardStatus]}` }} />
            <span style={{ color: "#665533", textTransform: "uppercase", letterSpacing: 1,
              fontFamily: "'IBM Plex Mono', monospace" }}>Shard</span>
          </div>
          <div style={{ padding: "5px 10px", background: s.role === "creator" ? "#F3D63015" : "#0d0a04",
            borderRadius: 5, border: `1px solid ${s.role === "creator" ? "#F3D63040" : "#1a150e"}`,
            fontSize: 9, color: s.role === "creator" ? "#F3D630" : "#665533",
            fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 1, textTransform: "uppercase" }}>
            {s.role}
          </div>
        </div>

        {/* Balance */}
        <div style={{ background: "#0d0a04", borderRadius: 8, padding: 12, border: "1px solid #1a150e" }}>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422",
            fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>{SHARD.token}</div>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "'Bebas Neue', sans-serif",
            color: "#F3D630", letterSpacing: 2 }}>{s.bal.toLocaleString()}</div>
        </div>

        {/* Story info */}
        <div style={{ background: "#0d0a04", borderRadius: 8, padding: 12, border: "1px solid #1a150e" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#d4c4a8", lineHeight: 1.3,
            marginBottom: 4 }}>{STORY.title}</div>
          <div style={{ fontSize: 10, color: "#887755", fontFamily: "'IBM Plex Mono', monospace",
            marginBottom: 6 }}>{STORY.genre}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 14 }}>{STORY.author.emoji}</span>
            <span style={{ fontSize: 11, color: STORY.author.color }}>{STORY.author.name}</span>
            <span style={{ marginLeft: "auto", fontSize: 9, color: "#554422",
              fontFamily: "'IBM Plex Mono', monospace" }}>👁 {STORY.readers}</span>
          </div>
        </div>

        {/* Chapters */}
        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422",
          fontFamily: "'IBM Plex Mono', monospace" }}>Chapters</div>
        <ChapterNav chapters={STORY.chapters} current={s.viewingChapter}
          onSelect={id => d({ type: "VIEW_CH", id })} />

        {/* Characters */}
        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422",
          fontFamily: "'IBM Plex Mono', monospace", marginTop: 4 }}>Characters</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, overflow: "auto" }} className="sc">
          {STORY.characters.map(ch => (
            <CharacterCard key={ch.id} char={ch}
              isMe={ch.driver === me.id || s.drivingCharacter === ch.id}
              onTakeWheel={doTakeWheel} canAfford={s.bal >= COSTS.TAKE_WHEEL} />
          ))}
        </div>
      </div>

      {/* ═══ CENTER: Reading / Writing Pane ═══ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Chapter header */}
        <div style={{ padding: "16px 40px 12px", borderBottom: "1px solid #1a150e10",
          background: "#0a080410" }}>
          <div style={{ fontSize: 10, color: "#665533", fontFamily: "'IBM Plex Mono', monospace",
            letterSpacing: 2, marginBottom: 4 }}>
            CHAPTER {currentChapter.num}
            {currentChapter.author && (() => {
              const a = PLAYERS.find(p => p.id === currentChapter.author);
              return a ? <span style={{ color: a.color, marginLeft: 8 }}>by {a.emoji} {a.name}</span> : null;
            })()}
          </div>
          <div style={{ fontSize: 24, fontWeight: 300, color: "#d4c4a8", letterSpacing: 0.5 }}>
            {currentChapter.title}
          </div>
          {currentChapter.wordCount > 0 && (
            <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 10, color: "#554422",
              fontFamily: "'IBM Plex Mono', monospace" }}>
              <span>{currentChapter.wordCount} words</span>
              <span>👏 {currentChapter.applause}</span>
            </div>
          )}
        </div>

        {/* Reading area */}
        <div style={{ flex: 1, overflow: "auto", padding: "24px 40px 40px" }} className="sc">
          {currentChapter.text ? (
            <div style={{ maxWidth: 640, margin: "0 auto" }}>
              {currentChapter.text.split('\n').map((para, i) => (
                para.trim() ? (
                  <p key={i} style={{ fontSize: 16, lineHeight: 1.85, color: "#c4b498",
                    marginBottom: 20, textIndent: i > 0 ? 24 : 0, letterSpacing: 0.2 }}>
                    {para}
                  </p>
                ) : <div key={i} style={{ height: 12 }} />
              ))}

              {/* Tip the chapter author */}
              {currentChapter.author && (
                <div style={{ marginTop: 32, padding: 16, borderRadius: 8,
                  background: "#0d0a0430", border: "1px solid #1a150e",
                  display: "flex", alignItems: "center", gap: 10, animation: "fadeUp .4s" }}>
                  <span style={{ fontSize: 9, color: "#665533", fontFamily: "'IBM Plex Mono', monospace",
                    textTransform: "uppercase", letterSpacing: 1 }}>Tip this chapter</span>
                  <input type="number" value={tipTarget === currentChapter.author ? tipAmt : ""}
                    onFocus={() => setTipTarget(currentChapter.author)}
                    onChange={e => { setTipTarget(currentChapter.author); setTipAmt(e.target.value); }}
                    placeholder={`${COSTS.TIP_MIN}+`}
                    style={{ width: 60, background: "#080603", border: "1px solid #1a150e", borderRadius: 4,
                      padding: "5px 8px", color: "#F3D630", fontSize: 12, outline: "none",
                      fontFamily: "'IBM Plex Mono', monospace" }} />
                  <button onClick={() => doTip(currentChapter.author)}
                    disabled={!tipAmt || parseInt(tipAmt) < COSTS.TIP_MIN}
                    style={{ padding: "5px 12px", borderRadius: 4,
                      background: tipAmt && parseInt(tipAmt) >= COSTS.TIP_MIN ? "linear-gradient(135deg, #F3D630, #ff8c2d)" : "#1a150e",
                      border: "none", color: "#080603", fontWeight: 700, fontSize: 11, cursor: "pointer",
                      fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1 }}>
                    TIP ⚡
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* Open chapter — writing interface */
            <div style={{ maxWidth: 640, margin: "0 auto" }}>
              <div style={{ textAlign: "center", padding: "40px 0 24px" }}>
                <div style={{ fontSize: 14, color: "#665533", fontStyle: "italic", marginBottom: 12 }}>
                  This chapter is open for writing.
                </div>
                {canWrite ? (
                  <div style={{ fontSize: 11, color: "#F3D630", fontFamily: "'IBM Plex Mono', monospace" }}>
                    You're driving {STORY.characters.find(c => c.id === s.drivingCharacter)?.name || "a character"}.
                    Write your contribution below.
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: "#887755" }}>
                    Take the wheel on a character to start writing.
                    {s.role === "consumer" && <span style={{ color: "#F3D630" }}> ({COSTS.TAKE_WHEEL} {SHARD.token})</span>}
                  </div>
                )}
              </div>

              {canWrite && (
                <>
                  <textarea value={newStoryText} onChange={e => setNewStoryText(e.target.value)}
                    placeholder="Continue the story..."
                    style={{ width: "100%", minHeight: 200, background: "#0d0a04",
                      border: "1px solid #1a150e", borderRadius: 8, padding: 16,
                      color: "#c4b498", fontSize: 15, lineHeight: 1.8, resize: "vertical",
                      outline: "none", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: "#554422", fontFamily: "'IBM Plex Mono', monospace" }}>
                      {newStoryText.split(/\s+/).filter(Boolean).length} words
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={doAICoauthor} disabled={s.showAIPanel || s.bal < COSTS.AI_COAUTHOR}
                        style={{ padding: "6px 14px", borderRadius: 5,
                          background: !s.showAIPanel && s.bal >= COSTS.AI_COAUTHOR ? "#3FA9F520" : "#1a150e",
                          border: !s.showAIPanel && s.bal >= COSTS.AI_COAUTHOR ? "1px solid #3FA9F5" : "1px solid #33281a",
                          color: !s.showAIPanel ? "#3FA9F5" : "#554422", fontSize: 10, cursor: "pointer",
                          fontFamily: "'IBM Plex Mono', monospace" }}>
                        🤖 AI Co-Author ({COSTS.AI_COAUTHOR} ⚡)
                      </button>
                      <button style={{ padding: "6px 16px", borderRadius: 5,
                        background: "linear-gradient(135deg, #F3D630, #ff8c2d)",
                        border: "none", color: "#080603", fontWeight: 700, fontSize: 11,
                        cursor: "pointer", fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1 }}>
                        PUBLISH
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* AI Co-Author Panel */}
              {s.showAIPanel && (
                <div style={{ marginTop: 20, background: "#0d0a04", borderRadius: 8,
                  border: "1px solid #3FA9F530", padding: 14, animation: "fadeUp .3s" }}>
                  <div style={{ fontSize: 9, color: "#3FA9F5", fontFamily: "'IBM Plex Mono', monospace",
                    letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>
                    🤖 AI Co-Author Session
                  </div>
                  <div style={{ maxHeight: 200, overflow: "auto", marginBottom: 10 }} className="sc">
                    {s.aiMessages.map((m, i) => (
                      <div key={i} style={{ marginBottom: 8,
                        padding: "8px 10px", borderRadius: 6,
                        background: m.role === "ai" ? "#3FA9F508" : "#1a150e",
                        border: m.role === "ai" ? "1px solid #3FA9F515" : "1px solid transparent" }}>
                        <div style={{ fontSize: 9, color: m.role === "ai" ? "#3FA9F5" : "#887755",
                          fontFamily: "'IBM Plex Mono', monospace", marginBottom: 3 }}>
                          {m.role === "ai" ? "AI" : "You"}
                        </div>
                        <div style={{ fontSize: 13, color: "#bba888", lineHeight: 1.6 }}>{m.text}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input value={aiInput} onChange={e => setAiInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && doAISend()}
                      placeholder="Ask the AI to help develop this scene..."
                      style={{ flex: 1, background: "#080603", border: "1px solid #1a150e", borderRadius: 5,
                        padding: "7px 10px", color: "#bbb", fontSize: 11, outline: "none" }} />
                    <button onClick={doAISend} style={{
                      background: "linear-gradient(135deg, #3FA9F5, #3FA9F5cc)",
                      border: "none", borderRadius: 5, padding: "7px 12px", color: "#080603",
                      fontWeight: 700, fontSize: 11, cursor: "pointer",
                      fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1 }}>↑</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ═══ RIGHT: Comments & Social ═══ */}
      <div style={{ width: 280, minWidth: 280, background: "#0a080440",
        borderLeft: "1px solid #1a150e", display: "flex", flexDirection: "column", padding: 14, gap: 10 }}>

        {/* Me */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 8, background: "#0d0a04",
          borderRadius: 8, border: `1px solid ${me.color}20` }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%",
            background: `linear-gradient(135deg, ${me.color}, ${me.color}80)`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{me.emoji}</div>
          <div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 14, letterSpacing: 2 }}>{me.name}</div>
            <div style={{ fontSize: 9, color: "#665533", fontFamily: "'IBM Plex Mono', monospace" }}>
              {s.role === "creator" ? "CREATOR" : "READER"}
              {s.drivingCharacter && ` · ${STORY.characters.find(c => c.id === s.drivingCharacter)?.name}`}
            </div>
          </div>
        </div>

        {/* Engagement costs */}
        <div style={{ background: "#0d0a04", borderRadius: 8, padding: 10, border: "1px solid #1a150e" }}>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422",
            fontFamily: "'IBM Plex Mono', monospace", marginBottom: 6 }}>Engagement</div>
          {[
            { label: "Comment", cost: "Free", color: "#2dff8c" },
            { label: "Drive Character", cost: `${COSTS.TAKE_WHEEL} ⚡`, color: "#F3D630" },
            { label: "Talk to Author", cost: `${COSTS.TALK_TO_AUTHOR} ⚡`, color: "#ff8c2d" },
            { label: "AI Co-Author", cost: `${COSTS.AI_COAUTHOR} ⚡`, color: "#3FA9F5" },
          ].map(e => (
            <div key={e.label} style={{ display: "flex", justifyContent: "space-between",
              padding: "3px 0", fontSize: 10 }}>
              <span style={{ color: "#887755" }}>{e.label}</span>
              <span style={{ color: e.color, fontFamily: "'IBM Plex Mono', monospace", fontSize: 9 }}>{e.cost}</span>
            </div>
          ))}
        </div>

        {/* Tx log */}
        {s.txs.length > 0 && (
          <div style={{ background: "#0d0a04", borderRadius: 8, padding: 10, border: "1px solid #1a150e",
            maxHeight: 100, overflow: "auto" }} className="sc">
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422",
              fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>Tips Sent</div>
            {[...s.txs].reverse().map(tx => {
              const to = PLAYERS.find(p => p.id === tx.to);
              return (
                <div key={tx.id} style={{ display: "flex", alignItems: "center", gap: 4,
                  padding: "3px 0", fontSize: 10, animation: "fadeUp .2s" }}>
                  <span>→</span><span>{to?.emoji}</span>
                  <span style={{ color: "#887755" }}>{to?.name}</span>
                  <span style={{ marginLeft: "auto", color: "#F3D630", fontWeight: 600,
                    fontFamily: "'IBM Plex Mono', monospace", fontSize: 9 }}>-{tx.amt} ⚡</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Comments */}
        <div style={{ flex: 1, background: "#0d0a04", borderRadius: 8, border: "1px solid #1a150e",
          display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "10px 10px 6px", fontSize: 9, textTransform: "uppercase",
            letterSpacing: 1.5, color: "#554422", fontFamily: "'IBM Plex Mono', monospace" }}>
            Comments on Ch. {currentChapter.num}
            <span style={{ color: "#443320", marginLeft: 4 }}>({chapterComments.length})</span>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "0 10px" }} className="sc">
            {chapterComments.length === 0 && (
              <div style={{ textAlign: "center", padding: "20px 0", color: "#443320",
                fontSize: 11, fontStyle: "italic" }}>No comments yet. Be the first.</div>
            )}
            {chapterComments.map(c => (
              <Comment key={c.id} c={c} onApplaud={id => d({ type: "APPLAUD", id })} />
            ))}
            <div ref={commentEnd} />
          </div>
          <div style={{ padding: 8, borderTop: "1px solid #0d0a04", display: "flex", gap: 5 }}>
            <input value={newComment} onChange={e => setNewComment(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doComment()}
              placeholder="Leave a comment..."
              style={{ flex: 1, background: "#080603", border: "1px solid #1a150e", borderRadius: 5,
                padding: "7px 9px", color: "#bbb", fontSize: 11, outline: "none" }} />
            <button onClick={doComment} disabled={!newComment.trim()}
              style={{ background: newComment.trim() ? "linear-gradient(135deg, #F3D630, #ff8c2d)" : "#1a150e",
                border: "none", borderRadius: 5, padding: "7px 10px", color: "#080603",
                fontWeight: 700, fontSize: 11, cursor: newComment.trim() ? "pointer" : "default",
                fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1 }}>↑</button>
          </div>
        </div>
      </div>
    </div>
  );
}
