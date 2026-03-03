import { useState, useEffect, useCallback, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
// F1R3Ink — Collective Emotional Intelligence
// Shard-native storage: all game state lives on the shared shard
// ══════════════════════════════════════════════════════════════════

// ── Shard key schema ─────────────────────────────────────────────
// player:{id}          → { id, name, tags, joinedAt }
// ink:{targetId}:{ts}:{fromId}  → { from, target, color, ts }
//
// Players discovered by listing "player:" prefix
// Inks for a target discovered by listing "ink:{targetId}:" prefix
// All keys are shared (visible to all players)
// ─────────────────────────────────────────────────────────────────

const SHARD_PREFIX_PLAYER = "f1r3ink-player:";
const SHARD_PREFIX_INK = "f1r3ink-ink:";
const SHARD_MY_ID_KEY = "f1r3ink-myid";
const POLL_INTERVAL = 2000;

// ── Color palette ────────────────────────────────────────────────
const INK_COLORS = [
  { hex: "#FF2D55", name: "rose" },
  { hex: "#FF6B2B", name: "ember" },
  { hex: "#FFD60A", name: "gold" },
  { hex: "#30D158", name: "verdant" },
  { hex: "#00C7BE", name: "teal" },
  { hex: "#40C8E0", name: "sky" },
  { hex: "#5E5CE6", name: "indigo" },
  { hex: "#BF5AF2", name: "violet" },
  { hex: "#FF375F", name: "coral" },
  { hex: "#FFFFFF", name: "light" },
  { hex: "#8E8E93", name: "ash" },
  { hex: "#1C1C1E", name: "void" },
];

// ── Shard helpers ────────────────────────────────────────────────
const shard = {
  async get(key) {
    try {
      const r = await window.storage.get(key, true);
      return r?.value ? JSON.parse(r.value) : null;
    } catch { return null; }
  },
  async set(key, value) {
    try {
      await window.storage.set(key, JSON.stringify(value), true);
      return true;
    } catch { return false; }
  },
  async delete(key) {
    try {
      await window.storage.delete(key, true);
      return true;
    } catch { return false; }
  },
  async list(prefix) {
    try {
      const r = await window.storage.list(prefix, true);
      return r?.keys || [];
    } catch { return []; }
  },
  // Personal (not shared) storage for remembering which player I am
  async getLocal(key) {
    try {
      const r = await window.storage.get(key, false);
      return r?.value ? JSON.parse(r.value) : null;
    } catch { return null; }
  },
  async setLocal(key, value) {
    try {
      await window.storage.set(key, JSON.stringify(value), false);
    } catch {}
  },
};

// ── Avatar generation ────────────────────────────────────────────
function hashSeed(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function AvatarSigil({ seed, size = 64 }) {
  const s = seed % 10000;
  const hue1 = s % 360;
  const hue2 = (s * 7 + 120) % 360;
  const r = size * 0.38;
  const shapes = [];

  for (let i = 0; i < 5; i++) {
    const angle = ((Math.PI * 2) / 5) * i + ((s * (i + 1)) % 60) * 0.02;
    const dist = r * 0.3 + ((s * (i + 3)) % 40) * r * 0.012;
    const cx = size / 2 + Math.cos(angle) * dist;
    const cy = size / 2 + Math.sin(angle) * dist;
    const sr = 4 + ((s * (i + 2)) % 8);
    shapes.push(
      <circle key={`c${i}`} cx={cx} cy={cy} r={sr}
        fill={`hsl(${i % 2 === 0 ? hue1 : hue2}, 70%, 65%)`} opacity={0.85} />
    );
  }
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = ((Math.PI * 2) / 6) * i + (s % 30) * 0.05;
    const d = r * 0.25 + ((s * (i + 1)) % 20) * 0.5;
    pts.push(`${size / 2 + Math.cos(angle) * d},${size / 2 + Math.sin(angle) * d}`);
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r}
        fill={`hsl(${hue1}, 25%, 15%)`} stroke={`hsl(${hue1}, 50%, 40%)`} strokeWidth="1.5" />
      {shapes}
      <polygon points={pts.join(" ")} fill="none"
        stroke={`hsl(${hue2}, 60%, 70%)`} strokeWidth="1.2" opacity="0.7" />
    </svg>
  );
}

// ── Freak Flag ───────────────────────────────────────────────────
function FreakFlag({ stripes, seed, size = 64, showFull = false }) {
  const flagH = showFull ? Math.max(size, stripes.length * 4 + 20) : size;
  const sh = stripes.length > 0 ? Math.min(6, (flagH - 10) / stripes.length) : 6;

  return (
    <div style={{
      position: "relative",
      width: showFull ? size + 80 : size + 40,
      height: flagH, display: "flex", alignItems: "center",
    }}>
      <div style={{
        position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
        width: "100%", display: "flex", flexDirection: "column", gap: 1,
      }}>
        {stripes.map((s, i) => (
          <div key={i} style={{
            height: sh,
            background: `linear-gradient(90deg, transparent 0%, ${s.color}88 15%, ${s.color} 40%, ${s.color}66 80%, transparent 100%)`,
            borderRadius: 2,
            animation: `stripeIn 0.6s ${i * 0.05}s ease-out both`,
          }} />
        ))}
      </div>
      <div style={{ position: "relative", zIndex: 2, flexShrink: 0,
        filter: "drop-shadow(0 0 6px rgba(0,0,0,0.8))" }}>
        <AvatarSigil seed={seed} size={size} />
      </div>
    </div>
  );
}

// ── Color Picker ─────────────────────────────────────────────────
function ColorPicker({ onSelect, selectedColor }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", padding: "8px 0" }}>
      {INK_COLORS.map((c) => (
        <button key={c.hex} onClick={() => onSelect(c.hex)} title={c.name}
          style={{
            width: 28, height: 28, borderRadius: "50%", background: c.hex,
            border: selectedColor === c.hex ? "2px solid #fff"
              : c.hex === "#1C1C1E" ? "1px solid #444" : "1px solid transparent",
            cursor: "pointer", transition: "transform 0.15s, box-shadow 0.15s",
            transform: selectedColor === c.hex ? "scale(1.25)" : "scale(1)",
            boxShadow: selectedColor === c.hex ? `0 0 12px ${c.hex}88` : "none",
          }} />
      ))}
    </div>
  );
}

// ── Tag editor ───────────────────────────────────────────────────
function TagEditor({ tags, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tags.join(", "));

  const save = () => {
    const t = draft.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
    onUpdate(t);
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="mood, vibe, role..." autoFocus
          style={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 4,
            color: "#ccc", padding: "4px 8px", fontSize: 12,
            fontFamily: "'DM Mono', monospace", width: "100%", maxWidth: 200 }} />
        <button onClick={save}
          style={{ background: "none", border: "1px solid #555", color: "#aaa",
            borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer",
            fontFamily: "'DM Mono', monospace" }}>ok</button>
      </div>
    );
  }

  return (
    <div onClick={() => { setDraft(tags.join(", ")); setEditing(true); }}
      style={{ display: "flex", flexWrap: "wrap", gap: 4, cursor: "pointer", minHeight: 24 }}
      title="click to edit tags">
      {tags.length === 0 && (
        <span style={{ color: "#555", fontSize: 11, fontStyle: "italic" }}>+ add tags</span>
      )}
      {tags.map((t, i) => (
        <span key={i} style={{
          background: "#1a1a2e", border: "1px solid #2a2a4a", borderRadius: 3,
          padding: "1px 7px", fontSize: 11, color: "#8888aa",
          fontFamily: "'DM Mono', monospace",
        }}>{t}</span>
      ))}
    </div>
  );
}

// ── Wheel entry ──────────────────────────────────────────────────
function WheelEntry({ player, stripes, isSelected, onSelect }) {
  const seed = hashSeed(player.id);
  return (
    <div onClick={onSelect} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
      borderRadius: 8, cursor: "pointer",
      background: isSelected ? "#1a1a3a" : "transparent",
      border: isSelected ? "1px solid #3a3a6a" : "1px solid transparent",
      transition: "all 0.2s",
    }}>
      <FreakFlag stripes={stripes} seed={seed} size={42} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: isSelected ? "#e0e0ff" : "#999",
          fontFamily: "'DM Mono', monospace",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {player.name}
        </div>
        {player.tags?.length > 0 && (
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 3 }}>
            {player.tags.slice(0, 3).map((t, i) => (
              <span key={i} style={{ fontSize: 9, color: "#666", background: "#111",
                padding: "0 4px", borderRadius: 2 }}>{t}</span>
            ))}
          </div>
        )}
        <div style={{ fontSize: 9, color: "#444", marginTop: 2 }}>
          {stripes.length} ink{stripes.length !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}

// ── Shard status indicator ───────────────────────────────────────
function ShardStatus({ connected, playerCount, inkCount, lastSync }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 9, color: "#444" }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: connected ? "#30D158" : "#FF453A",
        boxShadow: connected ? "0 0 6px #30D15866" : "0 0 6px #FF453A66",
        animation: connected ? "breathe 2s ease-in-out infinite" : "none",
      }} />
      <span style={{ letterSpacing: 1 }}>
        SHARD {connected ? "LIVE" : "OFFLINE"}
      </span>
      <span style={{ color: "#333" }}>|</span>
      <span>{playerCount} player{playerCount !== 1 ? "s" : ""}</span>
      <span style={{ color: "#333" }}>|</span>
      <span>{inkCount} ink{inkCount !== 1 ? "s" : ""}</span>
      {lastSync && (
        <>
          <span style={{ color: "#333" }}>|</span>
          <span>sync {new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        </>
      )}
    </div>
  );
}

// ── Join / Registration screen ───────────────────────────────────
function JoinScreen({ onJoin, existingPlayers }) {
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");

  const handleJoin = () => {
    const n = name.trim();
    if (!n) return;
    const t = tags.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
    onJoin(n, t);
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a14", display: "flex",
      alignItems: "center", justifyContent: "center", flexDirection: "column",
      fontFamily: "'DM Mono', monospace",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap');
        @keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        * { box-sizing: border-box; }
      `}</style>

      <div style={{ animation: "fadeIn 0.6s ease-out", textAlign: "center" }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 300, letterSpacing: 6,
          color: "#888", fontFamily: "'Noto Serif', serif" }}>
          F1R3<span style={{ color: "#FF6B2B", fontWeight: 700 }}>Ink</span>
        </h1>
        <div style={{ fontSize: 10, color: "#444", marginTop: 4, letterSpacing: 2 }}>
          COLLECTIVE EMOTIONAL INTELLIGENCE
        </div>

        <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            placeholder="your name"
            style={{ background: "#111", border: "1px solid #2a2a4a", borderRadius: 6,
              color: "#ccc", padding: "10px 16px", fontSize: 14, width: 260,
              fontFamily: "'DM Mono', monospace", textAlign: "center" }} />
          <input value={tags} onChange={(e) => setTags(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            placeholder="tags: mood, vibe, role..."
            style={{ background: "#111", border: "1px solid #1a1a2e", borderRadius: 6,
              color: "#888", padding: "8px 16px", fontSize: 11, width: 260,
              fontFamily: "'DM Mono', monospace", textAlign: "center" }} />
          <button onClick={handleJoin}
            style={{ background: "#FF6B2B", color: "#fff", border: "none", borderRadius: 6,
              padding: "10px 32px", fontSize: 13, fontFamily: "'DM Mono', monospace",
              fontWeight: 500, cursor: "pointer", letterSpacing: 3, marginTop: 8,
              boxShadow: "0 0 20px #FF6B2B44" }}>
            JOIN
          </button>
        </div>

        {existingPlayers.length > 0 && (
          <div style={{ marginTop: 32, color: "#333", fontSize: 10, letterSpacing: 1 }}>
            {existingPlayers.length} already playing:
            <div style={{ marginTop: 6, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              {existingPlayers.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <AvatarSigil seed={hashSeed(p.id)} size={20} />
                  <span style={{ color: "#555", fontSize: 10 }}>{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════
export default function F1R3Ink() {
  const [phase, setPhase] = useState("loading"); // loading | join | play
  const [myId, setMyId] = useState(null);
  const [players, setPlayers] = useState([]);
  const [inksByTarget, setInksByTarget] = useState({});
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [selectedColor, setSelectedColor] = useState(null);
  const [flash, setFlash] = useState(null);
  const [shardOk, setShardOk] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const pollRef = useRef(null);
  const scrollRef = useRef(null);

  const currentPlayer = players.find((p) => p.id === myId);
  const otherPlayers = players.filter((p) => p.id !== myId);
  const currentSeed = myId ? hashSeed(myId) : 0;
  const myStripes = inksByTarget[myId] || [];
  const totalInks = Object.values(inksByTarget).reduce((a, b) => a + b.length, 0);

  // ── Shard: load all players ──────────────────────────────────
  const loadPlayers = useCallback(async () => {
    const keys = await shard.list(SHARD_PREFIX_PLAYER);
    const all = [];
    for (const k of keys) {
      const p = await shard.get(k);
      if (p) all.push(p);
    }
    all.sort((a, b) => a.joinedAt - b.joinedAt);
    setPlayers(all);
    return all;
  }, []);

  // ── Shard: load all inks for all known players ───────────────
  const loadAllInks = useCallback(async (playerList) => {
    const pl = playerList || players;
    const result = {};
    for (const p of pl) {
      const keys = await shard.list(`${SHARD_PREFIX_INK}${p.id}:`);
      const inks = [];
      for (const k of keys) {
        const ink = await shard.get(k);
        if (ink) inks.push(ink);
      }
      inks.sort((a, b) => a.ts - b.ts);
      result[p.id] = inks;
    }
    setInksByTarget(result);
    return result;
  }, [players]);

  // ── Shard: full sync cycle ───────────────────────────────────
  const syncFromShard = useCallback(async () => {
    try {
      const pl = await loadPlayers();
      await loadAllInks(pl);
      setShardOk(true);
      setLastSync(Date.now());
    } catch {
      setShardOk(false);
    }
  }, [loadPlayers, loadAllInks]);

  // ── Init: check if we already have an identity ───────────────
  useEffect(() => {
    (async () => {
      const savedId = await shard.getLocal(SHARD_MY_ID_KEY);
      if (savedId) {
        const p = await shard.get(`${SHARD_PREFIX_PLAYER}${savedId}`);
        if (p) {
          setMyId(savedId);
          await syncFromShard();
          setPhase("play");
          return;
        }
      }
      await loadPlayers();
      setPhase("join");
    })();
  }, []); // eslint-disable-line

  // ── Polling loop ─────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "play") return;
    pollRef.current = setInterval(syncFromShard, POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, [phase, syncFromShard]);

  // ── Join handler ─────────────────────────────────────────────
  const handleJoin = async (name, tags) => {
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const player = { id, name, tags, joinedAt: Date.now() };
    await shard.set(`${SHARD_PREFIX_PLAYER}${id}`, player);
    await shard.setLocal(SHARD_MY_ID_KEY, id);
    setMyId(id);
    await syncFromShard();
    setPhase("play");
  };

  // ── Ink action: append-only write to shard ───────────────────
  const inkPlayer = async () => {
    if (!selectedTarget || !selectedColor || !myId) return;
    const ts = Date.now();
    const inkKey = `${SHARD_PREFIX_INK}${selectedTarget}:${ts}:${myId}`;
    const inkData = { from: myId, target: selectedTarget, color: selectedColor, ts };
    const ok = await shard.set(inkKey, inkData);
    if (ok) {
      setInksByTarget((prev) => ({
        ...prev,
        [selectedTarget]: [...(prev[selectedTarget] || []), inkData],
      }));
      setFlash(selectedColor);
      setTimeout(() => setFlash(null), 400);
      setSelectedColor(null);
    }
  };

  // ── Update tags on shard ─────────────────────────────────────
  const updateMyTags = async (newTags) => {
    if (!currentPlayer) return;
    const updated = { ...currentPlayer, tags: newTags };
    await shard.set(`${SHARD_PREFIX_PLAYER}${myId}`, updated);
    setPlayers((prev) => prev.map((p) => (p.id === myId ? updated : p)));
  };

  // ── Leave game ───────────────────────────────────────────────
  const leaveGame = async () => {
    if (myId) {
      await shard.delete(`${SHARD_PREFIX_PLAYER}${myId}`);
      for (const p of players) {
        const keys = await shard.list(`${SHARD_PREFIX_INK}${p.id}:`);
        for (const k of keys) {
          if (k.endsWith(`:${myId}`)) await shard.delete(k);
        }
      }
      await shard.setLocal(SHARD_MY_ID_KEY, null);
    }
    setMyId(null);
    setPhase("join");
    await loadPlayers();
  };

  const getStripesFor = (pid) => inksByTarget[pid] || [];

  // ── Loading screen ───────────────────────────────────────────
  if (phase === "loading") {
    return (
      <div style={{ minHeight: "100vh", background: "#0a0a14", display: "flex",
        alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace" }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&display=swap');
          @keyframes pulse { 0%,100% { opacity:0.3; } 50% { opacity:1; } }
        `}</style>
        <div style={{ color: "#555", fontSize: 12, letterSpacing: 2,
          animation: "pulse 1.5s ease-in-out infinite" }}>
          connecting to shard...
        </div>
      </div>
    );
  }

  if (phase === "join") {
    return <JoinScreen onJoin={handleJoin} existingPlayers={players} />;
  }

  // ── Play screen ──────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a14", color: "#ddd",
      fontFamily: "'DM Mono', 'Fira Code', monospace",
      display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
    }}>
      {flash && (
        <div style={{
          position: "fixed", inset: 0, background: flash, opacity: 0.12,
          pointerEvents: "none", zIndex: 100, animation: "flashFade 0.4s ease-out forwards",
        }} />
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap');
        @keyframes stripeIn { from { opacity:0; transform:scaleX(0); transform-origin:left; } to { opacity:1; transform:scaleX(1); } }
        @keyframes flashFade { from { opacity:0.15; } to { opacity:0; } }
        @keyframes breathe { 0%,100% { opacity:0.6; } 50% { opacity:1; } }
        @keyframes slideUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:#2a2a4a; border-radius:2px; }
        * { box-sizing:border-box; }
      `}</style>

      {/* Header */}
      <header style={{
        padding: "12px 20px 8px", borderBottom: "1px solid #1a1a2e",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 300, letterSpacing: 4,
            color: "#888", fontFamily: "'Noto Serif', serif" }}>
            F1R3<span style={{ color: "#FF6B2B", fontWeight: 700 }}>Ink</span>
          </h1>
          <div style={{ marginTop: 2 }}>
            <ShardStatus connected={shardOk} playerCount={players.length}
              inkCount={totalInks} lastSync={lastSync} />
          </div>
        </div>
        <button onClick={leaveGame}
          style={{ background: "none", border: "1px solid #2a2a4a", color: "#555",
            borderRadius: 4, padding: "4px 10px", fontSize: 10, cursor: "pointer",
            fontFamily: "'DM Mono', monospace", letterSpacing: 1 }}>
          LEAVE
        </button>
      </header>

      {/* Two-column layout */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* LEFT: My flag */}
        <div style={{
          width: "38%", minWidth: 180, borderRight: "1px solid #1a1a2e",
          padding: "20px 16px", display: "flex", flexDirection: "column",
          alignItems: "center", gap: 16, overflowY: "auto",
        }}>
          <div style={{ fontSize: 10, color: "#555", letterSpacing: 2 }}>MY FLAG</div>
          <FreakFlag stripes={myStripes} seed={currentSeed} size={72} showFull />
          <div style={{ fontSize: 16, color: "#ccc", fontFamily: "'Noto Serif', serif", fontWeight: 700 }}>
            {currentPlayer?.name}
          </div>

          <div style={{ width: "100%", maxWidth: 200 }}>
            <div style={{ fontSize: 9, color: "#444", marginBottom: 4, letterSpacing: 1 }}>TAGS</div>
            <TagEditor tags={currentPlayer?.tags || []} onUpdate={updateMyTags} />
          </div>

          {myStripes.length > 0 && (
            <div style={{ width: "100%", maxWidth: 200, marginTop: 8, animation: "slideUp 0.3s ease-out" }}>
              <div style={{ fontSize: 9, color: "#444", letterSpacing: 1, marginBottom: 6 }}>INKED BY</div>
              {myStripes.slice().reverse().slice(0, 12).map((s, i) => {
                const from = players.find((p) => p.id === s.from);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%",
                      background: s.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 10, color: "#666" }}>{from?.name || "?"}</span>
                    <span style={{ fontSize: 9, color: "#333" }}>
                      {new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {myStripes.length === 0 && (
            <div style={{ color: "#333", fontSize: 11, fontStyle: "italic",
              textAlign: "center", marginTop: 20, lineHeight: 1.6 }}>
              no ink yet<br />
              <span style={{ fontSize: 9 }}>others will color your flag</span>
            </div>
          )}
        </div>

        {/* RIGHT: Community wheel */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "16px 16px 8px", fontSize: 10, color: "#555", letterSpacing: 2 }}>
            COMMUNITY WHEEL
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
            {otherPlayers.length === 0 && (
              <div style={{ color: "#333", fontSize: 11, fontStyle: "italic",
                textAlign: "center", marginTop: 40, lineHeight: 1.8 }}>
                waiting for others to join...<br />
                <span style={{ fontSize: 9 }}>share this artifact to play together</span>
              </div>
            )}
            {otherPlayers.map((p) => (
              <WheelEntry key={p.id} player={p} stripes={getStripesFor(p.id)}
                isSelected={selectedTarget === p.id}
                onSelect={() => setSelectedTarget(selectedTarget === p.id ? null : p.id)} />
            ))}
          </div>

          {selectedTarget && (
            <div style={{ borderTop: "1px solid #1a1a2e", padding: "12px 16px",
              animation: "slideUp 0.2s ease-out" }}>
              <div style={{ fontSize: 11, color: "#666", marginBottom: 6, textAlign: "center" }}>
                ink <span style={{ color: "#aaa" }}>
                  {players.find((p) => p.id === selectedTarget)?.name}
                </span> with a color
              </div>
              <ColorPicker onSelect={setSelectedColor} selectedColor={selectedColor} />
              {selectedColor && (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <button onClick={inkPlayer}
                    style={{
                      background: selectedColor,
                      color: selectedColor === "#FFD60A" || selectedColor === "#FFFFFF" ? "#111" : "#fff",
                      border: "none", borderRadius: 6, padding: "8px 28px", fontSize: 13,
                      fontFamily: "'DM Mono', monospace", fontWeight: 500, cursor: "pointer",
                      letterSpacing: 2, boxShadow: `0 0 20px ${selectedColor}44`,
                      transition: "transform 0.1s",
                    }}
                    onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.95)")}
                    onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}>
                    INK
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer style={{
        padding: "6px 20px", borderTop: "1px solid #1a1a2e",
        display: "flex", justifyContent: "space-between", fontSize: 9, color: "#333", letterSpacing: 1,
      }}>
        <span>shard keys: player:{players.length} + ink:{totalInks}</span>
        <span>poll: {POLL_INTERVAL / 1000}s</span>
        <span>id: {myId?.slice(0, 10)}...</span>
      </footer>
    </div>
  );
}
