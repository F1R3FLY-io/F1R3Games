// The gallery renderers (design §9): the Portal posts {event: "preview",
// data: {header, body}}. A pattern plays its score as a loop; a session plays
// its history back, frame by block, beneath the loop.
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { decodePatternBody, decodeSession, frames, fromHex, gridAt } from "./core/history.js";
import { LoopPlayer } from "./core/audio.js";
import { ROWS, cellIndex } from "./core/grid.js";
import "./ui/styles.css";

function Cells({ pattern, playhead }) {
  const { steps } = pattern.shape;
  return (
    <div className="grid preview-grid" style={{ gridTemplateColumns: `4.5em repeat(${steps}, minmax(18px, 1fr))` }}>
      {ROWS.map((r, row) => [<div key={r} className="row-label">{r}</div>, ...Array.from({ length: steps }, (_, t) => {
        const v = pattern.cells[cellIndex(t, row)];
        return <div key={`${r}${t}`} className={`gcell${v ? " on" : ""}${t === playhead ? " now" : ""}${t % pattern.shape.perBar === 0 ? " bar" : ""}`}>{v && <span className="note">{v}</span>}</div>;
      })])}
    </div>
  );
}

export function Playback({ kind, header, body, player: given = null }) {
  const [step, setStep] = useState(null);
  const [bpm, setBpm] = useState(header?.tempo ?? 100);
  const player = useMemo(() => given ?? new LoopPlayer({ onStep: setStep }), [given]);
  const decoded = useMemo(() => {
    try {
      if (!body) return null;
      const b = fromHex(body.startsWith("0x") ? body.slice(2) : body);
      return kind === "session" ? { session: decodeSession(b) } : { pattern: decodePatternBody(b).pattern };
    } catch { return null; }
  }, [body, kind]);
  const fs = useMemo(() => (decoded?.session ? frames(decoded.session.sets) : []), [decoded]);
  const [at, setAt] = useState(Infinity);
  let pattern = decoded?.pattern ?? null;
  if (decoded?.session) {
    const s = decoded.session;
    const m = gridAt(s.sets, fs.length ? fs[Math.min(at, fs.length - 1)] : Infinity);
    pattern = { shape: s.shape, cells: Array.from({ length: s.shape.cells }, (_, c) => m.get(c) ?? null) };
  }
  useEffect(() => { if (pattern) player.setPattern(pattern); }, [pattern]);
  useEffect(() => () => player.stop(), [player]);
  if (!pattern) return <p className="muted small" style={{ padding: 12 }}>{header?.preview?.text ?? "This play has no body to show."}</p>;
  return (
    <div className="preview-page" style={{ padding: 12 }}>
      <div className="eyebrow">{header?.title ?? "F1R3Beat"}</div>
      <div className="record-row">
        <button onClick={() => { if (player.playing) player.stop(); else { player.setTempo(bpm); player.start(); } setStep(null); }}>{player.playing ? "■ Stop" : "▶ Play"}</button>
        <input type="range" min={40} max={240} value={bpm} aria-label="tempo" onChange={(e) => { setBpm(+e.target.value); player.setTempo(+e.target.value); }} />
        <span className="small muted">{bpm} bpm</span>
      </div>
      <Cells pattern={pattern} playhead={step} />
      {fs.length > 1 && (
        <div className="record-row">
          <input type="range" min={0} max={fs.length - 1} value={Math.min(at, fs.length - 1)} aria-label="block" onChange={(e) => setAt(Number(e.target.value))} />
          <span className="small muted">block {fs[Math.min(at, fs.length - 1)]}</span>
        </div>
      )}
      {header?.preview?.text && <p className="small muted">{header.preview.text}</p>}
    </div>
  );
}

function Host({ kind }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const h = (e) => { if (e.data && (e.data.f1r3games === 1 || e.data.f1r3games === 2) && e.data.event === "preview") setData(e.data.data); };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, []);
  return data ? <Playback kind={kind} header={data.header} body={data.body} /> : <p className="muted small" style={{ padding: 12 }}>Waiting for the play…</p>;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<Host kind={el.dataset.kind ?? "pattern"} />);
