import { useEffect, useMemo, useState } from "react";
import { boardAt, frames } from "../core/history.js";
import { buildPlay } from "../core/publish.js";

/** Playback with a scrubber (frame by block), and publishing the whole game or a moment (D9). */
export function Record({ game, state, onFrame }) {
  const [paints, setPaints] = useState(null);
  const [at, setAt] = useState(0);
  const [span, setSpan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [whole, setWhole] = useState(null);
  useEffect(() => { game.history().then(setPaints).catch((e) => setMsg(e.message)); }, [state.height]);
  const fs = useMemo(() => (paints ? frames(paints) : []), [paints]);
  useEffect(() => { if (fs.length) setAt(fs.length - 1); }, [fs.length]);
  useEffect(() => { if (paints && fs.length) onFrame(boardAt(paints, fs[at])); return () => onFrame(null); }, [paints, at]);
  if (!paints) return <div className="panel record">Loading the record…</div>;
  if (!fs.length) return <div className="panel record"><span className="muted small">Nothing has been painted yet.</span></div>;
  const players = Object.keys(state.seats).length;
  const publish = async (from, to, title) => {
    setBusy(true); setMsg(null);
    try {
      const { header, bodyHex } = buildPlay({ radius: state.board.radius, seats: state.seats, paints, from, to, title, blockHash: state.blockHash, players });
      const r = await game.bridge.publishPlay("canvas", header, bodyHex);
      if (whole && whole !== r.playId) { await game.bridge.linkPlays(r.playId, whole).catch(() => {}); }
      if (!span) setWhole(r.playId);
      setMsg(`Published (${r.playId}).`);
    } catch (e) { setMsg(e.code === "declined" ? "Not approved." : e.message ?? String(e)); }
    finally { setBusy(false); }
  };
  const first = fs[0], last = fs[fs.length - 1];
  return (
    <div className="panel record">
      <div className="record-row">
        <span className="eyebrow">Replay</span>
        <input type="range" min={0} max={fs.length - 1} value={at} aria-label="block" onChange={(e) => setAt(Number(e.target.value))} />
        <span className="small muted">block {fs[at]} · frame {at + 1} of {fs.length}</span>
      </div>
      <div className="record-row">
        <button className="ghost small" onClick={() => setSpan(span ? null : [at, at])}>{span ? "Cancel moment" : "Cut a moment"}</button>
        {span && (
          <>
            <button className="ghost small" onClick={() => setSpan([at, Math.max(at, span[1])])}>Start here</button>
            <button className="ghost small" onClick={() => setSpan([Math.min(at, span[0]), at])}>End here</button>
            <span className="small">blocks {fs[span[0]]}–{fs[span[1]]}</span>
            <button className="small" disabled={busy} onClick={() => publish(fs[span[0]], fs[span[1]] + 1, `A moment of ${state.instance?.id?.slice(0, 8)}`)}>Publish moment</button>
          </>
        )}
        {!span && <button className="small" disabled={busy} onClick={() => publish(first, last + 1, `F1R3Pix · ${players} players`)}>Publish whole game</button>}
      </div>
      {msg && <p className="small muted" role="status">{msg}</p>}
    </div>
  );
}
