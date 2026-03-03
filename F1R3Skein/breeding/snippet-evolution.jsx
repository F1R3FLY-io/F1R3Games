import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─── F1R3FLY Shard Simulation ─────────────────────────────────────────────
// Models rholang state channels: data lives "on chain" in the tuplespace,
// not in a JS key-value map. Each snippet is deployed via a rholang contract
// that sends its data on an unforgeable name. Retrieval consumes + re-sends
// (the MakeCell / state-channel pattern from rholang design patterns).

class F1R3FLYShard {
  constructor() {
    // Simulates RSpace tuplespace: channel -> [messages]
    this.tuplespace = new Map();
    this.deployLog = [];
    this.blockHeight = 0;
  }

  // Deploy a rholang contract that stores a snippet on an unforgeable name
  deploy(snippetData) {
    const channel = `rho:snippet:${snippetData.id}`;
    // new snippetCh in { snippetCh!(snippetData) }
    this.tuplespace.set(channel, { ...snippetData, _channel: channel });
    this.blockHeight++;
    this.deployLog.push({
      block: this.blockHeight,
      action: "deploy",
      channel,
      timestamp: Date.now(),
      rholang: `new snippetCh(\`${channel}\`) in { snippetCh!(${JSON.stringify(snippetData.id)}) }`
    });
    return channel;
  }

  // Peek at data on a channel (for <<- non-consuming read)
  peek(channel) {
    return this.tuplespace.get(channel) || null;
  }

  // Consume + re-send pattern (for state channel reads)
  // for (data <- ch) { ch!(*data) | process!(*data) }
  consume(channel) {
    const data = this.tuplespace.get(channel);
    if (data) {
      // Re-send to channel (state channel pattern)
      this.tuplespace.set(channel, data);
      return { ...data };
    }
    return null;
  }

  // Update data on a channel (consume old, send new)
  update(channel, newData) {
    if (this.tuplespace.has(channel)) {
      this.tuplespace.set(channel, { ...newData, _channel: channel });
      this.blockHeight++;
      this.deployLog.push({
        block: this.blockHeight,
        action: "update",
        channel,
        timestamp: Date.now(),
      });
    }
  }

  // Remove from tuplespace (no re-send after consume)
  remove(channel) {
    const data = this.tuplespace.get(channel);
    this.tuplespace.delete(channel);
    this.blockHeight++;
    this.deployLog.push({
      block: this.blockHeight,
      action: "remove",
      channel,
      timestamp: Date.now(),
    });
    return data;
  }

  // List all snippet channels (simulates rholang registry lookup)
  listChannels() {
    return Array.from(this.tuplespace.entries())
      .filter(([k]) => k.startsWith("rho:snippet:"))
      .map(([, v]) => v);
  }

  getLog() {
    return this.deployLog.slice(-20);
  }
}

// ─── Musical Constants ────────────────────────────────────────────────────
// Pentatonic scale (base 5 → 5 pitch classes per octave spread across base 22)
const SCALE_NOTES = [
  "C3","D3","E3","G3","A3",
  "C4","D4","E4","G4","A4",
  "C5","D5","E5","G5","A5",
  "C6","D6","E6","G6","A6",
  "C7","D7"
]; // 22 pitches (base 22)

const NOTE_FREQS = {
  "C3":130.81,"D3":146.83,"E3":164.81,"G3":196.00,"A3":220.00,
  "C4":261.63,"D4":293.66,"E4":329.63,"G4":392.00,"A4":440.00,
  "C5":523.25,"D5":587.33,"E5":659.25,"G5":783.99,"A5":880.00,
  "C6":1046.50,"D6":1174.66,"E6":1318.51,"G6":1567.98,"A6":1760.00,
  "C7":2093.00,"D7":2349.32,"REST":0
};

// Duration values (base 5): indices 0-4 map to rhythmic values
const DURATIONS = [0.125, 0.25, 0.5, 0.75, 1.0]; // 32nd, 16th, 8th, dotted-8th, quarter

const DURATION_LABELS = ["♬32","♪16","♪8","♪8.","♩4"];

// ─── Genetic Operators ────────────────────────────────────────────────────

function coinFlip() {
  return Math.random() < 0.5;
}

// Convert a pitch index (0-21, base 22) to a duration index (0-4, base 5)
function pitchToDuration(pitchIdx) {
  // Write pitch in base 5, take modulo to get duration index
  return pitchIdx % 5;
}

// Convert a duration index (0-4, base 5) to a pitch index (0-21, base 22)
function durationToPitch(durIdx) {
  // Write duration in base 22: scale up and add random offset within range
  return (durIdx * 4 + Math.floor(Math.random() * 4)) % 22;
}

// Introduce rests at random positions to pad shorter snippet to match longer
function padWithRests(shorter, targetLen) {
  const result = [...shorter];
  const restsNeeded = targetLen - shorter.length;
  for (let i = 0; i < restsNeeded; i++) {
    const pos = Math.floor(Math.random() * (result.length + 1));
    // REST pitch = -1, random duration
    result.splice(pos, 0, { pitch: -1, duration: Math.floor(Math.random() * 5) });
  }
  return result;
}

// Breed two snippets → 4 children
function breed(mother, father) {
  let mNotes = mother.notes.map(n => ({ ...n }));
  let fNotes = father.notes.map(n => ({ ...n }));

  // Equalize lengths by padding shorter with rests
  if (mNotes.length < fNotes.length) {
    mNotes = padWithRests(mNotes, fNotes.length);
  } else if (fNotes.length < mNotes.length) {
    fNotes = padWithRests(fNotes, mNotes.length);
  }

  const len = mNotes.length;
  const children = [];

  // Child 1: Mother's pitches + Father's durations
  const c1 = [];
  for (let i = 0; i < len; i++) {
    c1.push({ pitch: mNotes[i].pitch, duration: fNotes[i].duration });
  }
  children.push({ notes: c1, label: "M♪ + F♩" });

  // Child 2: Father's pitches + Mother's durations
  const c2 = [];
  for (let i = 0; i < len; i++) {
    c2.push({ pitch: fNotes[i].pitch, duration: mNotes[i].duration });
  }
  children.push({ notes: c2, label: "F♪ + M♩" });

  // Child 3: Mother's pitches + Father's pitches; coin flip → one becomes durations (base 5)
  const c3 = [];
  for (let i = 0; i < len; i++) {
    if (coinFlip()) {
      // Mother pitch stays pitch, Father pitch → duration via base 5
      c3.push({ pitch: mNotes[i].pitch, duration: pitchToDuration(Math.max(0, fNotes[i].pitch)) });
    } else {
      // Father pitch stays pitch, Mother pitch → duration via base 5
      c3.push({ pitch: fNotes[i].pitch, duration: pitchToDuration(Math.max(0, mNotes[i].pitch)) });
    }
  }
  children.push({ notes: c3, label: "M♪⊕F♪" });

  // Child 4: Mother's durations + Father's durations; coin flip → one becomes pitches (base 22)
  const c4 = [];
  for (let i = 0; i < len; i++) {
    if (coinFlip()) {
      // Mother duration stays duration, Father duration → pitch via base 22
      c4.push({ pitch: durationToPitch(fNotes[i].duration), duration: mNotes[i].duration });
    } else {
      // Father duration stays duration, Mother duration → pitch via base 22
      c4.push({ pitch: durationToPitch(mNotes[i].duration), duration: fNotes[i].duration });
    }
  }
  children.push({ notes: c4, label: "M♩⊕F♩" });

  return children;
}

// ─── Random Snippet Generator ─────────────────────────────────────────────
let snippetCounter = 0;
function generateSnippet(len = null) {
  const length = len || (4 + Math.floor(Math.random() * 9)); // 4-12 notes
  const notes = [];
  for (let i = 0; i < length; i++) {
    notes.push({
      pitch: Math.floor(Math.random() * 22),
      duration: Math.floor(Math.random() * 5),
    });
  }
  snippetCounter++;
  return {
    id: `snip_${Date.now()}_${snippetCounter}`,
    notes,
    engagement: 0,
    plays: 0,
    likes: 0,
    generation: 0,
    parents: null,
    createdAt: Date.now(),
    label: "Gen-0",
  };
}

// ─── Audio Engine ─────────────────────────────────────────────────────────
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.scheduledNodes = [];
  }

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  stop() {
    this.playing = false;
    this.scheduledNodes.forEach(n => {
      try { n.stop(); } catch(e) {}
    });
    this.scheduledNodes = [];
  }

  playSnippet(notes, onNoteStart, onComplete) {
    this.init();
    this.stop();
    this.playing = true;

    const tempo = 140; // BPM
    const beatDur = 60 / tempo;
    let time = this.ctx.currentTime + 0.05;

    notes.forEach((note, idx) => {
      const dur = DURATIONS[note.duration] * beatDur;
      if (note.pitch >= 0 && note.pitch < 22) {
        const noteName = SCALE_NOTES[note.pitch];
        const freq = NOTE_FREQS[noteName];
        if (freq > 0) {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          // Warm timbre: mix of sine + triangle
          osc.type = idx % 2 === 0 ? "sine" : "triangle";
          osc.frequency.setValueAtTime(freq, time);
          gain.gain.setValueAtTime(0, time);
          gain.gain.linearRampToValueAtTime(0.18, time + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, time + dur * 0.95);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(time);
          osc.stop(time + dur);
          this.scheduledNodes.push(osc);
        }
      }
      // Schedule highlight callback
      const noteTime = time;
      const noteIdx = idx;
      setTimeout(() => {
        if (this.playing && onNoteStart) onNoteStart(noteIdx);
      }, (noteTime - this.ctx.currentTime) * 1000);

      time += dur;
    });

    // On complete
    setTimeout(() => {
      if (this.playing) {
        this.playing = false;
        if (onComplete) onComplete();
      }
    }, (time - this.ctx.currentTime) * 1000 + 50);
  }
}

// ─── Components ───────────────────────────────────────────────────────────

const SHARD = new F1R3FLYShard();
const AUDIO = new AudioEngine();

// Seed initial population
function seedPopulation(count = 8) {
  for (let i = 0; i < count; i++) {
    const s = generateSnippet();
    SHARD.deploy(s);
  }
}

export default function App() {
  const [snippets, setSnippets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [breedingPair, setBreedingPair] = useState([]);
  const [children, setChildren] = useState([]);
  const [playingId, setPlayingId] = useState(null);
  const [activeNote, setActiveNote] = useState(-1);
  const [view, setView] = useState("browse"); // browse | breed | chain
  const [shardLog, setShardLog] = useState([]);
  const [generationCount, setGenerationCount] = useState(0);
  const [notification, setNotification] = useState(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      seedPopulation(8);
      refreshSnippets();
    }
  }, []);

  const refreshSnippets = useCallback(() => {
    const all = SHARD.listChannels();
    setSnippets(all.sort((a, b) => b.engagement - a.engagement));
    setShardLog(SHARD.getLog());
  }, []);

  const notify = useCallback((msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  }, []);

  const handlePlay = useCallback((snippet) => {
    if (playingId === snippet.id) {
      AUDIO.stop();
      setPlayingId(null);
      setActiveNote(-1);
      return;
    }

    // Increment plays + engagement on chain
    const ch = `rho:snippet:${snippet.id}`;
    const data = SHARD.consume(ch);
    if (data) {
      data.plays = (data.plays || 0) + 1;
      data.engagement = (data.engagement || 0) + 1;
      SHARD.update(ch, data);
    }

    setPlayingId(snippet.id);
    AUDIO.playSnippet(
      snippet.notes,
      (idx) => setActiveNote(idx),
      () => { setPlayingId(null); setActiveNote(-1); refreshSnippets(); }
    );
  }, [playingId, refreshSnippets]);

  const handleLike = useCallback((snippet) => {
    const ch = `rho:snippet:${snippet.id}`;
    const data = SHARD.consume(ch);
    if (data) {
      data.likes = (data.likes || 0) + 1;
      data.engagement = (data.engagement || 0) + 3; // Likes worth more
      SHARD.update(ch, data);
      refreshSnippets();
      notify(`♥ Liked! Engagement → ${data.engagement}`);
    }
  }, [refreshSnippets, notify]);

  const handleSelectForBreeding = useCallback((snippet) => {
    setBreedingPair(prev => {
      if (prev.find(s => s.id === snippet.id)) {
        return prev.filter(s => s.id !== snippet.id);
      }
      if (prev.length >= 2) return [prev[1], snippet];
      return [...prev, snippet];
    });
  }, []);

  const handleBreed = useCallback(() => {
    if (breedingPair.length !== 2) return;
    const [mother, father] = breedingPair;
    const newChildren = breed(mother, father);
    const gen = Math.max(mother.generation || 0, father.generation || 0) + 1;

    const deployedChildren = newChildren.map((child, idx) => {
      const snippet = {
        id: `snip_${Date.now()}_${++snippetCounter}`,
        notes: child.notes,
        engagement: 0,
        plays: 0,
        likes: 0,
        generation: gen,
        parents: [mother.id, father.id],
        createdAt: Date.now(),
        label: child.label,
      };
      SHARD.deploy(snippet);
      return snippet;
    });

    // Cull: remove random subset of least-engaged snippets
    const all = SHARD.listChannels();
    const sorted = all.sort((a, b) => a.engagement - b.engagement);
    const cullCount = 1 + Math.floor(Math.random() * 3); // Remove 1-3
    const toCull = sorted.slice(0, Math.min(cullCount, Math.max(0, sorted.length - 6)));
    toCull.forEach(s => {
      if (!deployedChildren.find(c => c.id === s.id)) {
        SHARD.remove(`rho:snippet:${s.id}`);
      }
    });

    setGenerationCount(gen);
    setChildren(deployedChildren);
    setBreedingPair([]);
    refreshSnippets();
    notify(`🧬 Bred generation ${gen}! ${toCull.length} low-engagement snippet(s) culled.`);
  }, [breedingPair, refreshSnippets, notify]);

  const handleAutoBreed = useCallback(() => {
    // Select top 2 by engagement for automatic breeding
    const all = SHARD.listChannels().sort((a, b) => b.engagement - a.engagement);
    if (all.length < 2) return;
    setBreedingPair([all[0], all[1]]);
    notify(`Auto-selected top 2: "${all[0].id.slice(-6)}" × "${all[1].id.slice(-6)}"`);
  }, [notify]);

  // Render note visualization
  const renderNotes = (notes, snippetId) => {
    return (
      <div style={{ display: "flex", gap: "2px", alignItems: "flex-end", minHeight: "48px", padding: "4px 0" }}>
        {notes.map((note, i) => {
          const isActive = playingId === snippetId && activeNote === i;
          const isRest = note.pitch < 0;
          const height = isRest ? 8 : 8 + (note.pitch / 21) * 40;
          const width = 4 + note.duration * 6;
          const hue = isRest ? 0 : (note.pitch / 21) * 280;
          return (
            <div
              key={i}
              style={{
                width: `${width}px`,
                height: `${height}px`,
                backgroundColor: isRest
                  ? "rgba(120,120,120,0.3)"
                  : `hsla(${hue}, 70%, ${isActive ? 65 : 45}%, ${isActive ? 1 : 0.75})`,
                borderRadius: "2px",
                transition: "all 0.08s ease",
                transform: isActive ? "scaleY(1.3)" : "scaleY(1)",
                border: isActive ? "1px solid rgba(255,255,255,0.8)" : "1px solid transparent",
              }}
              title={isRest ? "REST" : `${SCALE_NOTES[note.pitch]} ${DURATION_LABELS[note.duration]}`}
            />
          );
        })}
      </div>
    );
  };

  const motherColor = "rgba(255, 100, 130, 0.15)";
  const fatherColor = "rgba(100, 150, 255, 0.15)";

  return (
    <div style={{
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      background: "linear-gradient(170deg, #0a0a0f 0%, #0f1019 40%, #121218 100%)",
      color: "#d4d4d8",
      minHeight: "100vh",
      padding: "0",
      position: "relative",
      overflow: "hidden"
    }}>
      {/* Subtle grid background */}
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
        backgroundImage: "radial-gradient(rgba(100,120,255,0.03) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        pointerEvents: "none", zIndex: 0
      }} />

      {/* Notification */}
      {notification && (
        <div style={{
          position: "fixed", top: "16px", right: "16px", zIndex: 100,
          background: "rgba(30,30,50,0.95)", border: "1px solid rgba(100,150,255,0.3)",
          borderRadius: "8px", padding: "12px 20px",
          fontSize: "13px", color: "#a5b4fc",
          backdropFilter: "blur(12px)",
          animation: "fadeIn 0.2s ease"
        }}>
          {notification}
        </div>
      )}

      {/* Header */}
      <div style={{
        position: "relative", zIndex: 1,
        borderBottom: "1px solid rgba(100,120,255,0.1)",
        padding: "20px 28px",
        display: "flex", justifyContent: "space-between", alignItems: "center"
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{
              width: "10px", height: "10px", borderRadius: "50%",
              background: "radial-gradient(circle, #818cf8, #4f46e5)",
              boxShadow: "0 0 12px rgba(99,102,241,0.5)"
            }} />
            <h1 style={{
              margin: 0, fontSize: "18px", fontWeight: 600,
              letterSpacing: "0.05em", color: "#e0e7ff"
            }}>
              F1R3FLY SNIPPET EVOLUTION
            </h1>
          </div>
          <div style={{ fontSize: "11px", color: "#6366a0", marginTop: "4px", marginLeft: "22px" }}>
            Genetic music breeding on rholang state channels · Block #{SHARD.blockHeight} · Gen {generationCount} · Pop {snippets.length}
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          {["browse", "breed", "chain"].map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                background: view === v ? "rgba(99,102,241,0.2)" : "transparent",
                border: view === v ? "1px solid rgba(99,102,241,0.4)" : "1px solid rgba(100,120,255,0.1)",
                color: view === v ? "#a5b4fc" : "#6366a0",
                borderRadius: "6px", padding: "6px 14px",
                fontSize: "12px", cursor: "pointer", fontFamily: "inherit",
                transition: "all 0.15s ease",
                textTransform: "uppercase", letterSpacing: "0.08em"
              }}
            >
              {v === "browse" ? "◉ Browse" : v === "breed" ? "⚿ Breed" : "⛓ Chain"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ position: "relative", zIndex: 1, padding: "20px 28px" }}>

        {/* ─── BROWSE VIEW ───────────────────────────────────── */}
        {view === "browse" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div style={{ fontSize: "13px", color: "#818cf8" }}>
                Population ranked by engagement · Click ▶ to listen · ♥ to boost
              </div>
              <button
                onClick={() => { const s = generateSnippet(); SHARD.deploy(s); refreshSnippets(); notify("New random snippet deployed to shard"); }}
                style={{
                  background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
                  color: "#86efac", borderRadius: "6px", padding: "6px 12px",
                  fontSize: "11px", cursor: "pointer", fontFamily: "inherit"
                }}
              >
                + Deploy Random
              </button>
            </div>

            <div style={{ display: "grid", gap: "8px" }}>
              {snippets.map((snip, idx) => {
                const isSelected = breedingPair.find(s => s.id === snip.id);
                const isMother = breedingPair[0]?.id === snip.id;
                const isFather = breedingPair[1]?.id === snip.id;
                return (
                  <div
                    key={snip.id}
                    style={{
                      background: isMother ? motherColor : isFather ? fatherColor : "rgba(20,20,35,0.6)",
                      border: isSelected
                        ? `1px solid ${isMother ? "rgba(255,100,130,0.5)" : "rgba(100,150,255,0.5)"}`
                        : "1px solid rgba(100,120,255,0.08)",
                      borderRadius: "8px",
                      padding: "12px 16px",
                      display: "grid",
                      gridTemplateColumns: "40px 1fr auto",
                      gap: "12px",
                      alignItems: "center",
                      transition: "all 0.15s ease"
                    }}
                  >
                    {/* Rank */}
                    <div style={{
                      fontSize: "20px", fontWeight: 700,
                      color: idx < 3 ? "#818cf8" : "#3f3f5f",
                      textAlign: "center"
                    }}>
                      {idx + 1}
                    </div>

                    {/* Info + Visualization */}
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                        <span style={{ fontSize: "11px", color: "#6366a0" }}>
                          {snip.id.slice(-8)}
                        </span>
                        <span style={{
                          fontSize: "10px", padding: "1px 6px", borderRadius: "4px",
                          background: "rgba(99,102,241,0.1)", color: "#818cf8"
                        }}>
                          Gen {snip.generation}
                        </span>
                        <span style={{
                          fontSize: "10px", padding: "1px 6px", borderRadius: "4px",
                          background: "rgba(234,179,8,0.1)", color: "#fbbf24"
                        }}>
                          {snip.label}
                        </span>
                        <span style={{ fontSize: "10px", color: "#4a4a6a" }}>
                          {snip.notes.length} notes
                        </span>
                        {snip.parents && (
                          <span style={{ fontSize: "10px", color: "#4a4a6a" }}>
                            ← {snip.parents.map(p => p.slice(-6)).join(" × ")}
                          </span>
                        )}
                      </div>
                      {renderNotes(snip.notes, snip.id)}
                    </div>

                    {/* Controls */}
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <div style={{ textAlign: "right", marginRight: "8px" }}>
                        <div style={{ fontSize: "16px", fontWeight: 600, color: "#a5b4fc" }}>
                          {snip.engagement}
                        </div>
                        <div style={{ fontSize: "9px", color: "#4a4a6a" }}>
                          {snip.plays}▶ {snip.likes}♥
                        </div>
                      </div>

                      <button
                        onClick={() => handlePlay(snip)}
                        style={{
                          width: "36px", height: "36px", borderRadius: "50%",
                          background: playingId === snip.id ? "rgba(239,68,68,0.2)" : "rgba(99,102,241,0.15)",
                          border: playingId === snip.id ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(99,102,241,0.3)",
                          color: playingId === snip.id ? "#fca5a5" : "#a5b4fc",
                          cursor: "pointer", fontSize: "14px",
                          display: "flex", alignItems: "center", justifyContent: "center"
                        }}
                      >
                        {playingId === snip.id ? "■" : "▶"}
                      </button>

                      <button
                        onClick={() => handleLike(snip)}
                        style={{
                          width: "36px", height: "36px", borderRadius: "50%",
                          background: "rgba(236,72,153,0.1)",
                          border: "1px solid rgba(236,72,153,0.3)",
                          color: "#f472b6", cursor: "pointer", fontSize: "14px",
                          display: "flex", alignItems: "center", justifyContent: "center"
                        }}
                      >
                        ♥
                      </button>

                      <button
                        onClick={() => handleSelectForBreeding(snip)}
                        style={{
                          width: "36px", height: "36px", borderRadius: "50%",
                          background: isSelected
                            ? (isMother ? "rgba(255,100,130,0.2)" : "rgba(100,150,255,0.2)")
                            : "rgba(34,197,94,0.1)",
                          border: isSelected
                            ? `1px solid ${isMother ? "rgba(255,100,130,0.5)" : "rgba(100,150,255,0.5)"}`
                            : "1px solid rgba(34,197,94,0.3)",
                          color: isSelected ? (isMother ? "#fca5a5" : "#93c5fd") : "#86efac",
                          cursor: "pointer", fontSize: "12px",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontFamily: "inherit"
                        }}
                        title={isMother ? "Mother" : isFather ? "Father" : "Select for breeding"}
                      >
                        {isMother ? "M" : isFather ? "F" : "⚿"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── BREED VIEW ────────────────────────────────────── */}
        {view === "breed" && (
          <div>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr auto 1fr",
              gap: "20px", marginBottom: "24px", alignItems: "start"
            }}>
              {/* Mother */}
              <div style={{
                background: motherColor, border: "1px solid rgba(255,100,130,0.3)",
                borderRadius: "10px", padding: "16px"
              }}>
                <div style={{ fontSize: "11px", color: "#f472b6", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  ♀ Mother
                </div>
                {breedingPair[0] ? (
                  <div>
                    <div style={{ fontSize: "12px", color: "#d4d4d8", marginBottom: "6px" }}>
                      {breedingPair[0].id.slice(-8)} · Gen {breedingPair[0].generation} · {breedingPair[0].notes.length} notes
                    </div>
                    {renderNotes(breedingPair[0].notes, breedingPair[0].id)}
                    <button
                      onClick={() => handlePlay(breedingPair[0])}
                      style={{
                        marginTop: "8px", background: "rgba(255,100,130,0.1)",
                        border: "1px solid rgba(255,100,130,0.3)", borderRadius: "6px",
                        color: "#fca5a5", padding: "4px 12px", fontSize: "11px",
                        cursor: "pointer", fontFamily: "inherit"
                      }}
                    >
                      {playingId === breedingPair[0].id ? "■ Stop" : "▶ Play"}
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: "12px", color: "#4a4a6a", padding: "20px 0" }}>
                    Select a snippet from Browse view
                  </div>
                )}
              </div>

              {/* Breed button */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", paddingTop: "30px" }}>
                <button
                  onClick={handleBreed}
                  disabled={breedingPair.length !== 2}
                  style={{
                    width: "56px", height: "56px", borderRadius: "50%",
                    background: breedingPair.length === 2
                      ? "linear-gradient(135deg, rgba(236,72,153,0.3), rgba(99,102,241,0.3))"
                      : "rgba(30,30,50,0.5)",
                    border: breedingPair.length === 2
                      ? "2px solid rgba(168,85,247,0.5)"
                      : "1px solid rgba(100,120,255,0.1)",
                    color: breedingPair.length === 2 ? "#c4b5fd" : "#3f3f5f",
                    cursor: breedingPair.length === 2 ? "pointer" : "not-allowed",
                    fontSize: "20px",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "all 0.2s ease"
                  }}
                >
                  ⚿
                </button>
                <div style={{ fontSize: "10px", color: "#6366a0", textAlign: "center" }}>
                  BREED
                </div>
                <button
                  onClick={handleAutoBreed}
                  style={{
                    marginTop: "8px", background: "rgba(168,85,247,0.1)",
                    border: "1px solid rgba(168,85,247,0.3)", borderRadius: "6px",
                    color: "#c4b5fd", padding: "4px 10px", fontSize: "10px",
                    cursor: "pointer", fontFamily: "inherit"
                  }}
                >
                  Auto-select top 2
                </button>
              </div>

              {/* Father */}
              <div style={{
                background: fatherColor, border: "1px solid rgba(100,150,255,0.3)",
                borderRadius: "10px", padding: "16px"
              }}>
                <div style={{ fontSize: "11px", color: "#60a5fa", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  ♂ Father
                </div>
                {breedingPair[1] ? (
                  <div>
                    <div style={{ fontSize: "12px", color: "#d4d4d8", marginBottom: "6px" }}>
                      {breedingPair[1].id.slice(-8)} · Gen {breedingPair[1].generation} · {breedingPair[1].notes.length} notes
                    </div>
                    {renderNotes(breedingPair[1].notes, breedingPair[1].id)}
                    <button
                      onClick={() => handlePlay(breedingPair[1])}
                      style={{
                        marginTop: "8px", background: "rgba(100,150,255,0.1)",
                        border: "1px solid rgba(100,150,255,0.3)", borderRadius: "6px",
                        color: "#93c5fd", padding: "4px 12px", fontSize: "11px",
                        cursor: "pointer", fontFamily: "inherit"
                      }}
                    >
                      {playingId === breedingPair[1].id ? "■ Stop" : "▶ Play"}
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: "12px", color: "#4a4a6a", padding: "20px 0" }}>
                    Select a snippet from Browse view
                  </div>
                )}
              </div>
            </div>

            {/* Children */}
            {children.length > 0 && (
              <div>
                <div style={{
                  fontSize: "11px", color: "#a78bfa", marginBottom: "12px",
                  textTransform: "uppercase", letterSpacing: "0.1em"
                }}>
                  Offspring — deployed to shard
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                  {children.map((child, idx) => (
                    <div key={child.id} style={{
                      background: "rgba(168,85,247,0.06)",
                      border: "1px solid rgba(168,85,247,0.15)",
                      borderRadius: "8px", padding: "12px"
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                        <div>
                          <span style={{ fontSize: "12px", color: "#c4b5fd", fontWeight: 600 }}>
                            Child {idx + 1}
                          </span>
                          <span style={{
                            fontSize: "10px", marginLeft: "8px", padding: "1px 6px",
                            borderRadius: "4px", background: "rgba(168,85,247,0.15)", color: "#a78bfa"
                          }}>
                            {child.label}
                          </span>
                        </div>
                        <button
                          onClick={() => handlePlay(child)}
                          style={{
                            background: "rgba(168,85,247,0.15)",
                            border: "1px solid rgba(168,85,247,0.3)",
                            borderRadius: "50%", width: "28px", height: "28px",
                            color: "#c4b5fd", cursor: "pointer", fontSize: "11px",
                            display: "flex", alignItems: "center", justifyContent: "center"
                          }}
                        >
                          {playingId === child.id ? "■" : "▶"}
                        </button>
                      </div>
                      {renderNotes(child.notes, child.id)}
                      <div style={{ fontSize: "10px", color: "#6366a0", marginTop: "4px" }}>
                        {child.notes.length} notes · Gen {child.generation} · rho:snippet:{child.id.slice(-8)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Breeding Algorithm Explanation */}
            <div style={{
              marginTop: "24px", padding: "16px",
              background: "rgba(15,15,25,0.8)",
              border: "1px solid rgba(100,120,255,0.08)",
              borderRadius: "8px", fontSize: "11px", color: "#4a4a6a", lineHeight: 1.7
            }}>
              <div style={{ color: "#6366a0", marginBottom: "6px", fontWeight: 600 }}>Genetic Operators</div>
              <div><span style={{ color: "#818cf8" }}>Child 1</span> — Mother pitches + Father durations (stream unzip/rezip)</div>
              <div><span style={{ color: "#818cf8" }}>Child 2</span> — Father pitches + Mother durations (stream unzip/rezip)</div>
              <div><span style={{ color: "#818cf8" }}>Child 3</span> — Both pitch streams paired; coin flip selects which is written in base 5 → durations</div>
              <div><span style={{ color: "#818cf8" }}>Child 4</span> — Both duration streams paired; coin flip selects which is written in base 22 → pitches</div>
              <div style={{ marginTop: "6px" }}>If lengths differ, shorter snippet is padded with random rests (mutation). Low-engagement snippets are culled on each breed cycle.</div>
            </div>
          </div>
        )}

        {/* ─── CHAIN VIEW ────────────────────────────────────── */}
        {view === "chain" && (
          <div>
            <div style={{ fontSize: "13px", color: "#818cf8", marginBottom: "16px" }}>
              F1R3FLY Shard Tuplespace · Rholang State Channels
            </div>

            {/* Shard Stats */}
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "20px"
            }}>
              {[
                { label: "Block Height", value: SHARD.blockHeight },
                { label: "Channels", value: SHARD.tuplespace.size },
                { label: "Deploys", value: SHARD.deployLog.filter(l => l.action === "deploy").length },
                { label: "Culled", value: SHARD.deployLog.filter(l => l.action === "remove").length },
              ].map(stat => (
                <div key={stat.label} style={{
                  background: "rgba(20,20,35,0.6)", border: "1px solid rgba(100,120,255,0.08)",
                  borderRadius: "8px", padding: "12px", textAlign: "center"
                }}>
                  <div style={{ fontSize: "22px", fontWeight: 700, color: "#a5b4fc" }}>{stat.value}</div>
                  <div style={{ fontSize: "10px", color: "#4a4a6a", marginTop: "2px" }}>{stat.label}</div>
                </div>
              ))}
            </div>

            {/* Deploy Log */}
            <div style={{ fontSize: "11px", color: "#6366a0", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Recent Tuplespace Operations
            </div>
            <div style={{
              background: "rgba(10,10,18,0.8)", border: "1px solid rgba(100,120,255,0.08)",
              borderRadius: "8px", padding: "12px", maxHeight: "300px", overflowY: "auto",
              fontFamily: "'JetBrains Mono', monospace", fontSize: "11px"
            }}>
              {shardLog.slice().reverse().map((entry, i) => (
                <div key={i} style={{
                  padding: "4px 0",
                  borderBottom: "1px solid rgba(100,120,255,0.04)",
                  display: "flex", gap: "12px"
                }}>
                  <span style={{ color: "#3f3f5f", minWidth: "40px" }}>#{entry.block}</span>
                  <span style={{
                    color: entry.action === "deploy" ? "#86efac"
                      : entry.action === "remove" ? "#fca5a5"
                      : "#fbbf24",
                    minWidth: "55px"
                  }}>
                    {entry.action}
                  </span>
                  <span style={{ color: "#6366a0", flex: 1 }}>
                    {entry.channel}
                  </span>
                  <span style={{ color: "#3f3f5f" }}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>

            {/* Rholang Contract Display */}
            <div style={{
              marginTop: "20px", fontSize: "11px", color: "#6366a0",
              marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.1em"
            }}>
              Equivalent Rholang Contracts
            </div>
            <div style={{
              background: "rgba(10,10,18,0.9)", border: "1px solid rgba(100,120,255,0.08)",
              borderRadius: "8px", padding: "16px", fontSize: "11px",
              fontFamily: "'JetBrains Mono', monospace", color: "#818cf8",
              lineHeight: 1.8, whiteSpace: "pre-wrap"
            }}>
{`// Snippet Storage Contract
new snippetStore, lookup, breed, cull,
    stdout(\`rho:io:stdout\`) in {

  // Deploy snippet to unforgeable channel
  contract snippetStore(@id, @pitches, @durations,
                        @gen, ret) = {
    new dataCh in {
      dataCh!({"id": id, "pitches": pitches,
               "durations": durations,
               "engagement": 0, "gen": gen}) |
      ret!(*dataCh)
    }
  } |

  // State channel read (peek + re-send)
  contract lookup(@channel, ret) = {
    for (data <<- channel) {
      ret!(*data)
    }
  } |

  // Engagement update (consume + modified re-send)
  contract @"engage"(@channel, @delta) = {
    for (@data <- channel) {
      channel!(data.set("engagement",
        data.get("engagement") + delta))
    }
  } |

  // Breed: unzip streams, recombine
  contract breed(@motherCh, @fatherCh, ret) = {
    for (@m <<- motherCh; @f <<- fatherCh) {
      // Child 1: m.pitches ++ f.durations
      // Child 2: f.pitches ++ m.durations
      // Child 3: coinFlip(m.pitches, f.pitches)
      // Child 4: coinFlip(m.durations, f.durations)
      new c1, c2, c3, c4 in {
        snippetStore!(m.pitches, f.durations, *c1) |
        snippetStore!(f.pitches, m.durations, *c2) |
        ret!([*c1, *c2, *c3, *c4])
      }
    }
  }
}`}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        button:hover {
          filter: brightness(1.2);
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(100,120,255,0.15); border-radius: 3px; }
      `}</style>
    </div>
  );
}
