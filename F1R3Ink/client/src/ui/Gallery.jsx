import { useEffect, useState } from "react";
import { Flag, frameView } from "./Flag.jsx";
import { Replay } from "./Replay.jsx";

/** A play's header preview: the flags at the end of its span. */
export function PreviewFlags({ preview, size = 40 }) {
  if (!preview?.flags?.length) return <span className="small muted">no public flags</span>;
  return (
    <span className="preview-flags">
      {preview.flags.slice(0, 8).map((f) => <Flag key={f.p} view={frameView(f.s, preview.steps)} palette={preview.palette} name={f.n ?? f.p} size={size} />)}
    </span>
  );
}

/** This game's rounds and portraits (D14): view (recorded as a play), like. */
export function Gallery({ game, state }) {
  const [kind, setKind] = useState("round");
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { setList(null); game.plays(kind).then(setList).catch((e) => setMsg(e.message ?? String(e))); }, [kind, state.height]);
  const view = async (p) => {
    try { const body = await game.loadPlay(kind, p.id); setOpen({ play: p, body }); game.engage(p.id, "play").catch(() => {}); }
    catch (e) { setMsg(e.message ?? String(e)); }
  };
  return (
    <div className="panel gallery" aria-label="Gallery">
      <div className="record-row">
        <div className="toggle" role="tablist" aria-label="gallery">
          {[["round", "Rounds"], ["flag", "Portraits"]].map(([k, l]) => <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setOpen(null); }}>{l}</button>)}
        </div>
      </div>
      {!list && <p className="small muted">Loading…</p>}
      {list?.length === 0 && <p className="small muted">Nothing published yet. Publish from Replay.</p>}
      <ul className="patterns">
        {list?.map((p) => (
          <li key={p.id}>
            <PreviewFlags preview={p.preview} />
            <div className="pattern-meta">
              <strong>{p.title}</strong>
              <span className="small muted">{p.preview?.text} · {p.counts?.play ?? 0} views · {p.counts?.like ?? 0} likes</span>
              <span className="record-row">
                <button className="ghost small" onClick={() => view(p)}>View</button>
                <button className="ghost small" onClick={() => game.engage(p.id, "like").then(() => setMsg("Liked; it counts once the block is final."))}>Like</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {open && <Replay kind={kind} decoded={open.body} title={open.play.title} names={state.names} />}
      {msg && <p className="small muted" role="status">{msg}</p>}
    </div>
  );
}
