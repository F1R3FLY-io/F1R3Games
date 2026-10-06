import { useEffect, useState } from "react";
import { MiniGrid } from "./MiniGrid.jsx";
import { species } from "../core/grid.js";

/** This game's patterns: listen (recorded as a play), like, and cross two of one species (D15). */
export function Gallery({ game, state, player }) {
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = () => game.patterns().then(setList).catch((e) => setMsg(e.message ?? String(e)));
  useEffect(() => { load(); }, [state.height]);
  if (!list) return <div className="panel gallery">Loading patterns…</div>;
  const spec = (p) => `${p.meter?.[0]}/${p.meter?.[1]}@${p.column}`;
  const pick = (id) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));
  const listen = async (p) => {
    try {
      const pat = await game.loadPattern(p.id);
      player.setPattern(pat); player.setTempo(game.tempo); if (!player.playing) player.start();
      game.engage(p.id, "play").catch(() => {});
      setMsg(`Playing “${p.title}”. Play the grid again from the transport.`);
    } catch (e) { setMsg(e.message ?? String(e)); }
  };
  const [a, b] = picked.map((id) => list.find((p) => p.id === id));
  const canCross = a && b && spec(a) === spec(b);
  const cross = async () => { setBusy(true); setMsg(null); try { await game.cross(a.id, b.id); setPicked([]); await load(); } catch (e) { setMsg(e.message ?? String(e)); } finally { setBusy(false); } };
  return (
    <div className="panel gallery">
      <div className="record-row">
        <span className="eyebrow">Patterns</span>
        <span className="small muted">Select two of the same meter and column to cross them. Crosses join the breeding population once someone else likes them.</span>
      </div>
      {list.length === 0 && <p className="small muted">No patterns yet. Publish one from Replay.</p>}
      <ul className="patterns">
        {list.map((p) => (
          <li key={p.id} className={picked.includes(p.id) ? "on" : ""}>
            {p.preview && <MiniGrid preview={p.preview} />}
            <div className="pattern-meta">
              <strong>{p.title}</strong>
              <span className="small muted">{p.preview?.text} · {p.origin}{p.operator ? ` ${p.operator}` : ""} · {p.counts?.play ?? 0} plays · {p.counts?.like ?? 0} likes</span>
              <span className="record-row">
                <button className="ghost small" onClick={() => listen(p)}>Listen</button>
                <button className="ghost small" onClick={() => game.engage(p.id, "like").then(() => setMsg("Liked; it counts once the block is final."))}>Like</button>
                <button className="ghost small" aria-pressed={picked.includes(p.id)} onClick={() => pick(p.id)}>{picked.includes(p.id) ? "Selected" : "Select"}</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {picked.length === 2 && (
        <div className="record-row">
          {canCross ? <button disabled={busy} onClick={cross}>Cross these two</button> : <span className="small warn">Only patterns with the same meter and column can breed.</span>}
        </div>
      )}
      {msg && <p className="small muted" role="status">{msg}</p>}
    </div>
  );
}

export { species };
