import { useState, useEffect, useCallback, useRef, useMemo, useReducer } from "react";
import * as Tone from "tone";

// ═══════════════════════════════════════════════════════════════════
// F1R3Beat — Collective Intelligence Beat Sequencer
// A multiplayer game where a community creates a beat together.
// Each player controls a single cell: one instrument at one time slot.
// Their only action is toggling it on or off.
// Communication and token incentives drive coordination.
// ═══════════════════════════════════════════════════════════════════

// ─── Shard Integration (same pattern as F1R3Pix) ──────────────────
const SHARD = {
  grpcHost: "localhost",
  grpcExternal: 40401,
  grpcInternal: 40402,
  token: "F1R3Cap",
  phloLimit: 10_000_000,
  phloPrice: 1,
};

const shard = {
  connected: false,
  async connect() { this.connected = true; return true; },
  async deploy(rho) {
    console.log("[shard]", rho.slice(0, 50));
    return { ok: true, id: `d-${Date.now()}` };
  },
};

// ─── Instruments / Timbres ─────────────────────────────────────────
const INSTRUMENTS = [
  { id: "kick",    name: "Kick",      color: "#ff4d2d", icon: "◉", row: 0 },
  { id: "snare",   name: "Snare",     color: "#ff8c2d", icon: "◎", row: 1 },
  { id: "hihat",   name: "Hi-Hat",    color: "#ffb82d", icon: "✧", row: 2 },
  { id: "bass",    name: "Bass",      color: "#2dccff", icon: "♪", row: 3 },
  { id: "guitar",  name: "Guitar",    color: "#2dff8c", icon: "♫", row: 4 },
  { id: "keys",    name: "Keys",      color: "#b82dff", icon: "♬", row: 5 },
  { id: "sax",     name: "Sax",       color: "#ff2d8c", icon: "🎷", row: 6 },
];

// ─── Time Signature & Grid Config ──────────────────────────────────
const TIME_SIGS = [
  { label: "4/4", beatsPerBar: 4 },
  { label: "3/4", beatsPerBar: 3 },
  { label: "6/8", beatsPerBar: 6 },
  { label: "5/4", beatsPerBar: 5 },
];

const SIXTEENTHS_PER_BEAT = 4; // Each beat = 4 sixteenth notes

// ─── Players ───────────────────────────────────────────────────────
const PLAYERS = [
  { id: "p1",  name: "You",   emoji: "🔥", color: "#ff4d2d", addr: "1111aaaa" },
  { id: "p2",  name: "Aria",  emoji: "🌊", color: "#2dccff", addr: "2222bbbb" },
  { id: "p3",  name: "Kael",  emoji: "⚡", color: "#ffb82d", addr: "3333cccc" },
  { id: "p4",  name: "Nova",  emoji: "🌸", color: "#ff2d8c", addr: "4444dddd" },
  { id: "p5",  name: "Zeph",  emoji: "🍃", color: "#2dff8c", addr: "5555eeee" },
  { id: "p6",  name: "Onyx",  emoji: "🌑", color: "#b82dff", addr: "6666ffff" },
  { id: "p7",  name: "Lyra",  emoji: "✨", color: "#ffb82d", addr: "77770000" },
  { id: "p8",  name: "Rune",  emoji: "🔮", color: "#2dccff", addr: "88881111" },
];

// ─── Tone.js Synth Setup ──────────────────────────────────────────
function createSynths() {
  return {
    kick: new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 6, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 } }).toDestination(),
    snare: new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 } }).toDestination(),
    hihat: new Tone.MetalSynth({ frequency: 400, envelope: { attack: 0.001, decay: 0.06, release: 0.01 }, harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5 }).toDestination(),
    bass: new Tone.MonoSynth({ oscillator: { type: "sawtooth" }, envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.1 }, filterEnvelope: { attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.1, baseFrequency: 200, octaves: 2.5 } }).toDestination(),
    guitar: new Tone.PluckSynth({ attackNoise: 1.5, dampening: 3500, resonance: 0.92 }).toDestination(),
    keys: new Tone.PolySynth(Tone.Synth, { oscillator: { type: "triangle" }, envelope: { attack: 0.02, decay: 0.3, sustain: 0.3, release: 0.4 } }).toDestination(),
    sax: new Tone.MonoSynth({ oscillator: { type: "square" }, envelope: { attack: 0.05, decay: 0.2, sustain: 0.6, release: 0.3 }, filterEnvelope: { attack: 0.05, decay: 0.2, sustain: 0.5, release: 0.3, baseFrequency: 300, octaves: 3 } }).toDestination(),
  };
}

function triggerInstrument(synths, instrumentId) {
  const s = synths[instrumentId];
  if (!s) return;
  switch (instrumentId) {
    case "kick":   s.triggerAttackRelease("C1", "8n"); break;
    case "snare":  s.triggerAttackRelease("8n"); break;
    case "hihat":  s.triggerAttackRelease("32n"); break;
    case "bass":   s.triggerAttackRelease("E2", "8n"); break;
    case "guitar": s.triggerAttack("E3"); break;
    case "keys":   s.triggerAttackRelease(["C4", "E4", "G4"], "8n"); break;
    case "sax":    s.triggerAttackRelease("G4", "8n"); break;
  }
}

// ─── Assign Players to Grid Cells ──────────────────────────────────
function assignPlayersToGrid(rows, cols, players) {
  const totalCells = rows * cols;
  const assignment = {};
  const indices = Array.from({ length: totalCells }, (_, i) => i);
  // Shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  players.forEach((p, pi) => {
    if (pi < indices.length) {
      const idx = indices[pi];
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      assignment[`${row},${col}`] = p.id;
    }
  });
  return assignment;
}

// ─── State ─────────────────────────────────────────────────────────
const INIT = {
  grid: {},       // "row,col" -> true/false
  msgs: [
    { id: 1, from: "p3", to: ["p1"], text: "Let's build a 4-on-the-floor kick pattern!", t: Date.now() - 60000 },
    { id: 2, from: "p5", to: ["p1"], text: "I'll add some off-beat hi-hats", t: Date.now() - 30000 },
  ],
  txs: [
    { id: 1, from: "p1", to: "p3", amt: 50, t: Date.now() - 120000 },
  ],
  bal: 1000,
  shardStatus: "off",
  pend: [],
};

function reducer(s, a) {
  switch (a.type) {
    case "TOGGLE": {
      const prev = !!s.grid[a.k];
      return { ...s, grid: { ...s.grid, [a.k]: !prev } };
    }
    case "SET": return { ...s, grid: { ...s.grid, [a.k]: a.v } };
    case "MSG": return { ...s, msgs: [...s.msgs, a.m] };
    case "TX": return { ...s, txs: [...s.txs, a.tx], bal: s.bal - (a.tx.from === "p1" ? a.tx.amt : -a.tx.amt) };
    case "SH": return { ...s, shardStatus: a.v };
    case "+P": return { ...s, pend: [...s.pend, a.id] };
    case "-P": return { ...s, pend: s.pend.filter(x => x !== a.id) };
    default: return s;
  }
}

// ─── Message Bubble ────────────────────────────────────────────────
function Bubble({ msg, sent }) {
  const pl = PLAYERS.find(p => p.id === (sent ? msg.to?.[0] : msg.from));
  return (
    <div style={{ display: "flex", flexDirection: sent ? "row-reverse" : "row", gap: 8, alignItems: "flex-end", marginBottom: 8 }}>
      <div style={{ width: 22, height: 22, borderRadius: "50%", background: pl?.color || "#333",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0 }}>{pl?.emoji}</div>
      <div style={{ maxWidth: 190, padding: "7px 11px", borderRadius: sent ? "11px 11px 3px 11px" : "11px 11px 11px 3px",
        background: sent ? "#1e1510" : "#0e0a06", border: `1px solid ${pl?.color || "#333"}25`, fontSize: 11, color: "#bbb", lineHeight: 1.4 }}>
        <div style={{ fontSize: 9, color: pl?.color, marginBottom: 2, fontWeight: 600 }}>{sent ? `→ ${pl?.name}` : pl?.name}</div>
        {msg.text}
      </div>
    </div>
  );
}

// ═══ MAIN ══════════════════════════════════════════════════════════
export default function F1R3Beat() {
  const me = PLAYERS[0];
  const others = PLAYERS.slice(1);

  // Game setup
  const [timeSig, setTimeSig] = useState(TIME_SIGS[0]);
  const [numBars, setNumBars] = useState(2);
  const totalSixteenths = timeSig.beatsPerBar * SIXTEENTHS_PER_BEAT * numBars;

  const [owners] = useState(() => assignPlayersToGrid(INSTRUMENTS.length, totalSixteenths, PLAYERS));
  const [s, d] = useReducer(reducer, INIT);
  const [selPlayers, setSelPlayers] = useState(new Set());
  const [sendAmt, setSendAmt] = useState("");
  const [newMsg, setNewMsg] = useState("");
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [bpm, setBpm] = useState(120);
  const [audioReady, setAudioReady] = useState(false);

  const synthsRef = useRef(null);
  const seqRef = useRef(null);
  const msgEnd = useRef(null);

  // Shard connect
  useEffect(() => {
    d({ type: "SH", v: "connecting" });
    shard.connect().then(ok => d({ type: "SH", v: ok ? "on" : "off" }));
  }, []);

  useEffect(() => { msgEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [s.msgs]);

  // Simulate other players toggling
  useEffect(() => {
    const iv = setInterval(() => {
      const ks = Object.keys(owners).filter(k => owners[k] !== "p1");
      if (!ks.length) return;
      const rk = ks[Math.floor(Math.random() * ks.length)];
      d({ type: "TOGGLE", k: rk });
    }, 4000);
    return () => clearInterval(iv);
  }, [owners]);

  // Audio init
  const initAudio = useCallback(async () => {
    if (audioReady) return;
    await Tone.start();
    synthsRef.current = createSynths();
    setAudioReady(true);
  }, [audioReady]);

  // Sequencer
  const startStop = useCallback(async () => {
    if (!audioReady) await initAudio();
    if (playing) {
      Tone.Transport.stop();
      Tone.Transport.cancel();
      setPlaying(false);
      setCurrentStep(-1);
      return;
    }

    Tone.Transport.bpm.value = bpm;
    let step = 0;
    const totalSteps = totalSixteenths;

    seqRef.current = new Tone.Loop((time) => {
      const col = step % totalSteps;
      setCurrentStep(col);

      INSTRUMENTS.forEach((inst) => {
        const key = `${inst.row},${col}`;
        if (s.grid[key]) {
          triggerInstrument(synthsRef.current, inst.id);
        }
      });

      step++;
    }, "16n");

    seqRef.current.start(0);
    Tone.Transport.start();
    setPlaying(true);
  }, [audioReady, playing, bpm, totalSixteenths, s.grid, initAudio]);

  // Update loop when grid changes during playback
  useEffect(() => {
    if (seqRef.current) {
      seqRef.current.callback = (time) => {
        const col = Math.floor(Tone.Transport.ticks / Tone.Transport.PPQ * 4) % totalSixteenths;
        setCurrentStep(col);
        INSTRUMENTS.forEach((inst) => {
          const key = `${inst.row},${col}`;
          if (s.grid[key]) triggerInstrument(synthsRef.current, inst.id);
        });
      };
    }
  }, [s.grid, totalSixteenths]);

  // Cell click
  const clickCell = useCallback(async (row, col) => {
    const k = `${row},${col}`;
    if (owners[k] !== me.id) return;
    d({ type: "TOGGLE", k });
    const res = await shard.deploy(`@{"f1r3beat:grid:${row},${col}"}!(${!s.grid[k]})`);
    if (res.ok) { d({ type: "+P", id: res.id }); setTimeout(() => d({ type: "-P", id: res.id }), 1500); }
  }, [owners, me.id, s.grid]);

  const tog = useCallback(pid => {
    setSelPlayers(p => { const n = new Set(p); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });
  }, []);

  const doSendMsg = useCallback(async () => {
    if (!newMsg.trim() || !selPlayers.size) return;
    d({ type: "MSG", m: { id: Date.now(), from: me.id, to: [...selPlayers], text: newMsg.trim(), t: Date.now() } });
    setNewMsg("");
  }, [newMsg, selPlayers, me.id]);

  const doSendTokens = useCallback(async () => {
    const a = parseInt(sendAmt);
    if (!a || a <= 0 || a > s.bal || !selPlayers.size) return;
    const per = Math.floor(a / selPlayers.size);
    for (const pid of selPlayers) {
      d({ type: "TX", tx: { id: Date.now() + Math.random(), from: me.id, to: pid, amt: per, t: Date.now() } });
    }
    setSendAmt("");
  }, [sendAmt, s.bal, selPlayers, me]);

  const hiCells = useMemo(() => {
    const set = new Set();
    Object.entries(owners).forEach(([k, o]) => { if (selPlayers.has(o)) set.add(k); });
    return set;
  }, [owners, selPlayers]);

  const shC = { off: "#555", connecting: "#ffb82d", on: "#2dff8c", err: "#ff4d2d" };

  // ─── Grid dimensions ──────────────────────────────────────────
  const CELL_W = 28;
  const CELL_H = 36;
  const LABEL_W = 80;

  return (
    <div style={{ width: "100%", height: "100vh", background: "#0a0704", color: "#d4c4a8",
      fontFamily: "'IBM Plex Mono', 'Courier New', monospace", display: "flex", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Bebas+Neue&display=swap');
        @keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
        @keyframes slideIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes playhead{0%{box-shadow:0 0 8px #ff8c2d}50%{box-shadow:0 0 16px #ff8c2d,0 0 32px #ff4d2d40}100%{box-shadow:0 0 8px #ff8c2d}}
        .cell{transition:background .15s,box-shadow .15s,transform .08s}
        .cell:hover{transform:scale(1.08);z-index:2}
        .cell-on{animation:slideIn .2s ease}
        .st::-webkit-scrollbar{width:4px}.st::-webkit-scrollbar-track{background:transparent}
        .st::-webkit-scrollbar-thumb{background:#1a1408;border-radius:2px}
        input,textarea{font-family:'IBM Plex Mono',monospace}
      `}</style>

      {/* LEFT: Tokens */}
      <div style={{ width: 230, minWidth: 230, background: "#0d0a0440",
        borderRight: "1px solid #1a1408", display: "flex", flexDirection: "column", padding: 14, gap: 14 }}>

        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, letterSpacing: 4,
          textAlign: "center", padding: "6px 0",
          background: "linear-gradient(135deg, #ff4d2d, #ffb82d, #ff8c2d)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>F1R3BEAT</div>

        {/* Shard status */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#0d0a04",
          borderRadius: 6, border: "1px solid #1a1408", fontSize: 9 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: shC[s.shardStatus],
            boxShadow: `0 0 5px ${shC[s.shardStatus]}` }} />
          <span style={{ color: "#776644", textTransform: "uppercase", letterSpacing: 1 }}>Shard: {s.shardStatus}</span>
        </div>

        {/* Balance */}
        <div style={{ background: "#0d0a04", borderRadius: 10, padding: 14, border: "1px solid #1a1408" }}>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422", marginBottom: 6 }}>
            {SHARD.token} Balance</div>
          <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'Bebas Neue', sans-serif",
            color: "#ffb82d", textShadow: "0 0 16px #ffb82d30", letterSpacing: 2 }}>{s.bal.toLocaleString()}</div>
          <div style={{ fontSize: 9, color: "#443320", marginTop: 3 }}>staked • {me.addr}</div>
        </div>

        {/* Send */}
        <div style={{ background: "#0d0a04", borderRadius: 10, padding: 14, border: "1px solid #1a1408" }}>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422", marginBottom: 10 }}>
            Send {SHARD.token}</div>
          {!selPlayers.size ? <div style={{ fontSize: 10, color: "#332211", fontStyle: "italic" }}>Select players →</div> : <>
            <div style={{ fontSize: 10, color: "#776644", marginBottom: 7 }}>
              To: {[...selPlayers].map(pid => { const p = PLAYERS.find(x => x.id === pid); return p ? `${p.emoji} ${p.name}` : pid; }).join(", ")}</div>
            <div style={{ display: "flex", gap: 5 }}>
              <input type="number" value={sendAmt} onChange={e => setSendAmt(e.target.value)} placeholder="Amt"
                style={{ flex: 1, background: "#0a0704", border: "1px solid #1a1408", borderRadius: 6,
                  padding: 7, color: "#ffb82d", fontSize: 12, outline: "none", width: 70 }} />
              <button onClick={doSendTokens} style={{ background: "linear-gradient(135deg, #ffb82d, #ff8c2d)",
                border: "none", borderRadius: 6, padding: "7px 12px", color: "#0a0704",
                fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1 }}>SEND</button>
            </div>
          </>}
        </div>

        {/* Tx log */}
        <div style={{ flex: 1, background: "#0d0a04", borderRadius: 10, padding: 10,
          border: "1px solid #1a1408", overflow: "auto" }} className="st">
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422", marginBottom: 8 }}>
            Tx Log</div>
          {[...s.txs].reverse().slice(0, 15).map(tx => {
            const fr = PLAYERS.find(p => p.id === tx.from), to = PLAYERS.find(p => p.id === tx.to);
            const sent = tx.from === me.id;
            return (
              <div key={tx.id} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 0",
                borderBottom: "1px solid #0a0704", fontSize: 10, animation: "slideIn .3s" }}>
                <span style={{ color: sent ? "#ff4d2d" : "#2dff8c" }}>{sent ? "↑" : "↓"}</span>
                <span>{fr?.emoji}</span><span style={{ color: "#332211" }}>→</span><span>{to?.emoji}</span>
                <span style={{ marginLeft: "auto", color: sent ? "#ff4d2d" : "#2dff8c", fontWeight: 600 }}>
                  {sent ? "-" : "+"}{tx.amt}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* CENTER: Sequencer Grid */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Transport bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 20px",
          background: "#0d0a04", borderBottom: "1px solid #1a1408" }}>

          {/* Play/Stop */}
          <button onClick={startStop} style={{
            width: 40, height: 40, borderRadius: "50%",
            background: playing ? "linear-gradient(135deg, #ff4d2d, #ff8c2d)" : "#1a1408",
            border: playing ? "none" : "2px solid #332211", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, color: playing ? "#0a0704" : "#776644",
            boxShadow: playing ? "0 0 20px #ff4d2d40" : "none",
            transition: "all .2s",
          }}>
            {playing ? "■" : "▶"}
          </button>

          {/* BPM */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, color: "#554422", textTransform: "uppercase", letterSpacing: 1 }}>BPM</span>
            <input type="number" value={bpm} onChange={e => { const v = parseInt(e.target.value); if (v > 0) { setBpm(v); Tone.Transport.bpm.value = v; } }}
              style={{ width: 50, background: "#0a0704", border: "1px solid #1a1408", borderRadius: 4,
                padding: "4px 6px", color: "#ffb82d", fontSize: 13, textAlign: "center", outline: "none",
                fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1 }} />
          </div>

          {/* Time Sig */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {TIME_SIGS.map(ts => (
              <button key={ts.label} onClick={() => !playing && setTimeSig(ts)}
                style={{
                  padding: "4px 8px", borderRadius: 4, fontSize: 11,
                  background: timeSig.label === ts.label ? "#ff8c2d20" : "transparent",
                  border: timeSig.label === ts.label ? "1px solid #ff8c2d" : "1px solid #1a1408",
                  color: timeSig.label === ts.label ? "#ffb82d" : "#554422",
                  cursor: playing ? "default" : "pointer", fontFamily: "'Bebas Neue', sans-serif",
                  letterSpacing: 1, opacity: playing ? 0.5 : 1,
                }}>
                {ts.label}
              </button>
            ))}
          </div>

          {/* Bars */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 9, color: "#554422", textTransform: "uppercase", letterSpacing: 1 }}>Bars</span>
            {[1, 2, 4].map(n => (
              <button key={n} onClick={() => !playing && setNumBars(n)}
                style={{
                  padding: "4px 8px", borderRadius: 4, fontSize: 11,
                  background: numBars === n ? "#ff8c2d20" : "transparent",
                  border: numBars === n ? "1px solid #ff8c2d" : "1px solid #1a1408",
                  color: numBars === n ? "#ffb82d" : "#554422",
                  cursor: playing ? "default" : "pointer", fontFamily: "'Bebas Neue', sans-serif",
                  letterSpacing: 1, opacity: playing ? 0.5 : 1,
                }}>
                {n}
              </button>
            ))}
          </div>

          {/* Step counter */}
          <div style={{ marginLeft: "auto", fontSize: 10, color: "#554422", letterSpacing: 1 }}>
            {currentStep >= 0 ? `Step ${currentStep + 1}/${totalSixteenths}` : "Stopped"}
            {s.pend.length > 0 && <span style={{ color: "#ffb82d", marginLeft: 8 }}>({s.pend.length} deploying)</span>}
          </div>

          {!audioReady && (
            <button onClick={initAudio} style={{
              padding: "5px 12px", borderRadius: 4, background: "#1a1408",
              border: "1px solid #332211", color: "#ffb82d", fontSize: 10, cursor: "pointer",
              fontFamily: "'IBM Plex Mono', monospace",
            }}>Enable Audio</button>
          )}
        </div>

        {/* Grid */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }} className="st">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {INSTRUMENTS.map((inst) => (
              <div key={inst.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
                {/* Instrument label */}
                <div style={{
                  width: LABEL_W, minWidth: LABEL_W, padding: "0 10px",
                  display: "flex", alignItems: "center", gap: 6, height: CELL_H,
                }}>
                  <span style={{ fontSize: 14 }}>{inst.icon}</span>
                  <span style={{ fontSize: 10, fontWeight: 600, color: inst.color, letterSpacing: 1,
                    textTransform: "uppercase", fontFamily: "'Bebas Neue', sans-serif" }}>{inst.name}</span>
                </div>

                {/* Cells */}
                <div style={{ display: "flex", gap: 1 }}>
                  {Array.from({ length: totalSixteenths }, (_, col) => {
                    const k = `${inst.row},${col}`;
                    const isOn = !!s.grid[k];
                    const isOwn = owners[k] === me.id;
                    const isHi = hiCells.has(k);
                    const isPlayhead = col === currentStep && playing;
                    const isBeatStart = col % SIXTEENTHS_PER_BEAT === 0;
                    const isBarStart = col % (SIXTEENTHS_PER_BEAT * timeSig.beatsPerBar) === 0;

                    return (
                      <div
                        key={col}
                        className={`cell ${isOn ? "cell-on" : ""}`}
                        onClick={() => clickCell(inst.row, col)}
                        style={{
                          width: CELL_W, height: CELL_H,
                          borderRadius: 3,
                          cursor: isOwn ? "pointer" : "default",
                          background: isOn
                            ? `${inst.color}${isPlayhead ? "" : "cc"}`
                            : isPlayhead
                              ? "#1a140880"
                              : isBeatStart
                                ? "#0f0b0660"
                                : "#0a070400",
                          border: isOwn
                            ? `1px solid ${inst.color}60`
                            : isHi
                              ? "1px solid #2dccff50"
                              : isBarStart
                                ? "1px solid #1a140880"
                                : "1px solid #0f0b0640",
                          boxShadow: isOn && isPlayhead
                            ? `0 0 12px ${inst.color}80, inset 0 0 8px ${inst.color}40`
                            : isOn
                              ? `inset 0 0 6px ${inst.color}30`
                              : isPlayhead
                                ? "inset 0 0 4px #ff8c2d15"
                                : "none",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          position: "relative",
                          marginLeft: isBarStart && col > 0 ? 6 : 0,
                        }}
                      >
                        {/* Ownership dot */}
                        {isOwn && !isOn && (
                          <div style={{ width: 4, height: 4, borderRadius: "50%",
                            background: `${inst.color}40` }} />
                        )}
                        {/* Highlight border for selected players */}
                        {isHi && !isOwn && (
                          <div style={{ position: "absolute", inset: 0, borderRadius: 3,
                            border: "1px solid #2dccff30", pointerEvents: "none" }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Beat markers */}
            <div style={{ display: "flex", marginLeft: LABEL_W, gap: 1, marginTop: 4 }}>
              {Array.from({ length: totalSixteenths }, (_, col) => {
                const beatNum = Math.floor(col / SIXTEENTHS_PER_BEAT) + 1;
                const isBarStart = col % (SIXTEENTHS_PER_BEAT * timeSig.beatsPerBar) === 0;
                const isBeat = col % SIXTEENTHS_PER_BEAT === 0;
                return (
                  <div key={col} style={{
                    width: CELL_W, textAlign: "center", fontSize: 8,
                    color: isBarStart ? "#776644" : isBeat ? "#443320" : "transparent",
                    fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1,
                    marginLeft: isBarStart && col > 0 ? 6 : 0,
                  }}>
                    {isBeat ? beatNum : "·"}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: Players & Messages */}
      <div style={{ width: 250, minWidth: 250, background: "#0d0a0440",
        borderLeft: "1px solid #1a1408", display: "flex", flexDirection: "column", padding: 14, gap: 10 }}>

        {/* Me */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, background: "#0d0a04",
          borderRadius: 10, border: `1px solid ${me.color}30` }}>
          <div style={{ width: 42, height: 42, borderRadius: "50%",
            background: `linear-gradient(135deg, ${me.color}, ${me.color}80)`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22,
            boxShadow: `0 0 16px ${me.color}25` }}>{me.emoji}</div>
          <div>
            <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontWeight: 400, fontSize: 16, letterSpacing: 2 }}>{me.name}</div>
            <div style={{ fontSize: 9, color: me.color, letterSpacing: 1 }}>ACTIVE</div>
          </div>
        </div>

        {/* Players */}
        <div style={{ background: "#0d0a04", borderRadius: 10, border: "1px solid #1a1408",
          padding: 8, maxHeight: 200, overflow: "auto" }} className="st">
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422", marginBottom: 6 }}>
            Players ({others.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {others.map(p => {
              const sel = selPlayers.has(p.id);
              return (
                <button key={p.id} onClick={() => tog(p.id)} style={{
                  display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", borderRadius: 8,
                  border: sel ? `1px solid ${p.color}` : "1px solid transparent",
                  background: sel ? `${p.color}12` : "transparent", cursor: "pointer",
                  transition: "all .2s", textAlign: "left", color: sel ? "#d4c4a8" : "#776644",
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%",
                    background: sel ? `linear-gradient(135deg, ${p.color}, ${p.color}80)` : "#0a0704",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13,
                    transition: "all .2s", boxShadow: sel ? `0 0 8px ${p.color}30` : "none" }}>{p.emoji}</div>
                  <span style={{ fontWeight: sel ? 600 : 400 }}>{p.name}</span>
                  {sel && <div style={{ marginLeft: "auto", width: 6, height: 6, borderRadius: "50%",
                    background: p.color, boxShadow: `0 0 4px ${p.color}` }} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, background: "#0d0a04", borderRadius: 10, border: "1px solid #1a1408",
          display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#554422",
            padding: "10px 10px 6px" }}>Messages</div>
          <div style={{ flex: 1, overflow: "auto", padding: "0 10px" }} className="st">
            {s.msgs.map(m => <Bubble key={m.id} msg={m} sent={m.from === me.id} />)}
            <div ref={msgEnd} />
          </div>
          <div style={{ padding: 8, borderTop: "1px solid #1a1408", display: "flex", gap: 5 }}>
            <input value={newMsg} onChange={e => setNewMsg(e.target.value)}
              onKeyDown={e => e.key === "Enter" && doSendMsg()}
              placeholder={selPlayers.size ? `Msg ${selPlayers.size}...` : "Select players..."}
              disabled={!selPlayers.size}
              style={{ flex: 1, background: "#0a0704", border: "1px solid #1a1408", borderRadius: 6,
                padding: "7px 9px", color: "#bbb", fontSize: 11, outline: "none" }} />
            <button onClick={doSendMsg} disabled={!selPlayers.size || !newMsg.trim()}
              style={{ background: selPlayers.size && newMsg.trim() ? "linear-gradient(135deg, #ff8c2d, #ff4d2d)" : "#1a1408",
                border: "none", borderRadius: 6, padding: "7px 10px", color: "#0a0704", fontSize: 11,
                cursor: selPlayers.size ? "pointer" : "default", fontWeight: 700,
                fontFamily: "'Bebas Neue', sans-serif", letterSpacing: 1 }}>↑</button>
          </div>
        </div>
      </div>
    </div>
  );
}
