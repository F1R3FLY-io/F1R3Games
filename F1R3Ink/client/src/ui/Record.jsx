import { useEffect, useMemo, useState } from "react";
import { frames } from "../core/history.js";
import { frameOf, stateAt } from "../core/publish.js";
import { Flag, frameView } from "./Flag.jsx";

/** The flags at block `h` of a replay: every public flag, and the viewer's own (its colours are the viewer's to know). */
export function FlagsAt({ events, h, palette, decay, names = {}, me = null, size = 48 }) {
  const st = stateAt(events, h);
  const at = events.filter((e) => e.h <= h).reduce((t, e) => Math.max(t, e.t), 0);
  const shown = Object.entries(st.players).filter(([a, p]) => p.public || a === me);
  if (!shown.length) return <p className="small muted">No public flag yet at this block.</p>;
  return (
    <ul className="flags-at">
      {shown.map(([a, p]) => {
        const veil = new Set(a === me ? [] : p.veil);
        const m = new Map([...(st.stripes[a] ?? new Map()).entries()].map(([k, s]) => [k, veil.has(k) ? { ...s, colour: null } : s]));
        return (
          <li key={a}>
            <Flag view={frameView(frameOf(m, { decay, now: at }), decay?.steps)} palette={palette} name={names[a] ?? a} size={size} />
            <span className="small">{a === me ? "you" : names[a] ?? a.slice(0, 8)}{p.public ? "" : " · private"}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Replay by block, and publishing the round or your own portrait (D14). */
export function Record({ game, state }) {
  const [events, setEvents] = useState(null);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [roundPlay, setRoundPlay] = useState(null);
  useEffect(() => { game.history().then(setEvents).catch((e) => setMsg(e.message ?? String(e))); }, [state.height]);
  const fs = useMemo(() => (events ? frames(events) : []), [events]);
  useEffect(() => { if (fs.length) setAt(fs.length - 1); }, [fs.length]);
  if (!events) return <div className="panel record">Loading the record…</div>;
  if (!fs.length) return <div className="panel record"><span className="muted small">Nothing has happened in this round yet.</span></div>;
  const first = fs[0], last = fs[fs.length - 1];
  const me = state.me?.address;
  const act = async (f) => { setBusy(true); setMsg(null); try { setMsg(await f()); } catch (e) { setMsg(e.code === "declined" ? "Not approved." : e.message ?? String(e)); } finally { setBusy(false); } };
  const players = Object.keys(state.players).length;
  const publishRound = () => act(async () => {
    const r = await game.publishRound(`F1R3Ink round · ${players} players`, first, last + 1);
    setRoundPlay(r.playId);
    return `Published the round (${r.playId}). It holds only what the chain already shows.`;
  });
  const publishPortrait = () => act(async () => {
    const r = await game.publishPortrait(`${state.names[me] ?? "A"} portrait`, first, last + 1, roundPlay);
    return `Published your portrait (${r.playId})${game.myFlag === "private" ? "; the colours on it are now disclosed" : ""}.`;
  });
  return (
    <div className="panel record" aria-label="Replay">
      <div className="record-row">
        <span className="eyebrow">Replay</span>
        <input type="range" min={0} max={fs.length - 1} value={at} aria-label="block" onChange={(e) => setAt(Number(e.target.value))} />
        <span className="small muted">block {fs[at]} · frame {at + 1} of {fs.length}</span>
      </div>
      <FlagsAt events={events} h={fs[at]} palette={state.round.palette} decay={state.round.decay} names={state.names} me={me} />
      <div className="record-row">
        <button className="small" disabled={busy} onClick={publishRound}>Publish the round</button>
        {game.entered && <button className="small" disabled={busy} onClick={publishPortrait}>Publish your portrait</button>}
        {game.entered && game.myFlag === "private" && <span className="small muted">A portrait of a private flag discloses its colours.</span>}
      </div>
      {msg && <p className="small muted" role="status">{msg}</p>}
    </div>
  );
}
