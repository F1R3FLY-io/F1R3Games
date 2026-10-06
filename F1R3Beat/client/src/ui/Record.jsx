import { useEffect, useMemo, useState } from "react";
import { frames, gridAt } from "../core/history.js";
import { buildSession } from "../core/publish.js";

/** Replay with a scrubber (frame by block), and publishing the session, a cut of it, or the pattern at a frame (D11). */
export function Record({ game, state, onFrame }) {
  const [sets, setSets] = useState(null);
  const [at, setAt] = useState(0);
  const [span, setSpan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [whole, setWhole] = useState(null);
  const base = game.seedBase;
  useEffect(() => { game.history().then(setSets).catch((e) => setMsg(e.message)); }, [state.height]);
  const fs = useMemo(() => (sets ? frames(sets) : []), [sets]);
  useEffect(() => { if (fs.length) setAt(fs.length - 1); }, [fs.length]);
  useEffect(() => { if (sets && fs.length) onFrame(gridAt(sets, fs[at], base)); return () => onFrame(null); }, [sets, at]);
  if (!sets) return <div className="panel record">Loading the record…</div>;
  if (!fs.length) return <div className="panel record"><span className="muted small">Nothing has been played yet.</span></div>;
  const players = Object.keys(state.seats).length;
  const shape = state.grid.shape;
  const act = async (f) => { setBusy(true); setMsg(null); try { setMsg(await f()); } catch (e) { setMsg(e.code === "declined" ? "Not approved." : e.message ?? String(e)); } finally { setBusy(false); } };
  const publishSession = (from, to, title) => act(async () => {
    const { header, bodyHex } = buildSession({ shape, sets, from, to, title, blockHash: state.blockHash, players, base });
    const r = await game.bridge.publishPlay("session", header, bodyHex);
    if (whole && whole !== r.playId) await game.bridge.linkPlays(r.playId, whole).catch(() => {});
    if (!span) setWhole(r.playId);
    return `Published the session (${r.playId}).`;
  });
  const publishPattern = () => act(async () => {
    const r = await game.publishPattern(`F1R3Beat · ${players} players`);
    if (whole) await game.bridge.linkPlays(r.playId, whole).catch(() => {});
    return `Published the pattern (${r.playId}). Patterns breed (§10).`;
  });
  const first = fs[0], last = fs[fs.length - 1];
  return (
    <div className="panel record">
      <div className="record-row">
        <span className="eyebrow">Replay</span>
        <input type="range" min={0} max={fs.length - 1} value={at} aria-label="block" onChange={(e) => setAt(Number(e.target.value))} />
        <span className="small muted">block {fs[at]} · frame {at + 1} of {fs.length}</span>
      </div>
      <div className="record-row">
        <button className="ghost small" onClick={() => setSpan(span ? null : [at, at])}>{span ? "Cancel cut" : "Cut a span"}</button>
        {span ? (
          <>
            <button className="ghost small" onClick={() => setSpan([at, Math.max(at, span[1])])}>Start here</button>
            <button className="ghost small" onClick={() => setSpan([Math.min(at, span[0]), at])}>End here</button>
            <span className="small">blocks {fs[span[0]]}–{fs[span[1]]}</span>
            <button className="small" disabled={busy} onClick={() => publishSession(fs[span[0]], fs[span[1]] + 1, `A span of ${state.instance?.id?.slice(0, 8)}`)}>Publish span</button>
          </>
        ) : (
          <>
            <button className="small" disabled={busy} onClick={() => publishSession(first, last + 1, `F1R3Beat session · ${players} players`)}>Publish session</button>
            <button className="small" disabled={busy} onClick={publishPattern}>Publish the pattern</button>
          </>
        )}
      </div>
      {msg && <p className="small muted" role="status">{msg}</p>}
    </div>
  );
}
