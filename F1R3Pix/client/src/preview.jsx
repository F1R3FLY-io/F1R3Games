// The `canvas` gallery renderer (design §10): the Portal posts
// {event: "preview", data: {header, body}}; this page plays the body back,
// frame by block, or shows the header's final frame when there is no body.
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { boardAt, decodeBody, decodePreview, fromHex, frames } from "./core/history.js";
import { board as cellsOf, corners, key } from "./core/hex.js";
import "./ui/styles.css";

const SIZE = 20;
const pts = (q, r) => corners(q, r, SIZE, 0.95).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

export function Playback({ header, body }) {
  const decoded = useMemo(() => { try { return body ? decodeBody(fromHex(body)) : null; } catch { return null; } }, [body]);
  const pv = useMemo(() => (header?.preview?.frame ? decodePreview(header.preview) : null), [header]);
  const fs = useMemo(() => (decoded ? frames(decoded.paints) : []), [decoded]);
  const [at, setAt] = useState(Infinity);
  const radius = decoded?.radius ?? pv?.radius ?? header?.radius ?? 4;
  const seated = pv?.cells ?? new Map();
  const frame = decoded && fs.length ? boardAt(decoded.paints, fs[Math.min(at, fs.length - 1)]) : pv?.cells ?? new Map();
  const ext = SIZE * Math.sqrt(3) * (radius + 0.5) + 4;
  return (
    <div className="preview-page" style={{ padding: 12 }}>
      <div className="eyebrow">{header?.title ?? "F1R3Pix"}</div>
      <svg viewBox={`${-ext} ${-ext} ${2 * ext} ${2 * ext}`} style={{ width: "100%", maxHeight: "80vh" }} role="img" aria-label="board">
        {cellsOf(radius).map(([q, r]) => {
          const k = key(q, r);
          const has = seated.has(k) || frame.has(k);
          const c = frame.get(k);
          return has ? <polygon key={k} points={pts(q, r)} fill={c ?? "#1E1E1E"} /> : <polygon key={k} points={pts(q, r)} fill="none" stroke="#333" strokeDasharray="2 2" />;
        })}
      </svg>
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

function Host() {
  const [data, setData] = useState(null);
  useEffect(() => {
    const h = (e) => { if (e.data && (e.data.f1r3games === 1 || e.data.f1r3games === 2) && e.data.event === "preview") setData(e.data.data); };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, []);
  return data ? <Playback header={data.header} body={data.body} /> : <p className="muted small" style={{ padding: 12 }}>Waiting for the play…</p>;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<Host />);
