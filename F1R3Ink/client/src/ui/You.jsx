import { useState } from "react";
import { Flag } from "./Flag.jsx";
import { parseTags, tagsOk } from "../core/ink.js";

/**
 * Left column, top (§11): your avatar with your full flag behind it, your
 * tags (edited in place), your flag's visibility with a reminder of who can
 * see it, and the veil over stripes on a public flag (D15).
 */
export function You({ game, state, onHistory, labels, setLabels }) {
  const [editing, setEditing] = useState(false);
  const [tagText, setTagText] = useState("");
  const [veiling, setVeiling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const me = state.me?.address;
  const p = state.players[me];
  const palette = state.round?.palette ?? [];
  const steps = state.round?.decay?.steps ?? null;
  const view = me && p ? game.view(me) : [];
  const act = async (f, done) => { setBusy(true); setMsg(null); try { await f(); if (done) setMsg(done); } catch (e) { setMsg(e.message ?? String(e)); } finally { setBusy(false); } };
  const closed = game.status === "closed";
  const reach = !p ? "" : p.flag === "public"
    ? state.round?.reciprocity ? "Everyone whose own flag is public sees your flag in full." : "Everyone in the round sees your flag in full."
    : "Only you see your flag in full. Each inker sees only their own stripe.";
  const veil = new Set(p?.veil ?? []);
  const toggleVeil = (key) => { const v = new Set(veil); v.has(key) ? v.delete(key) : v.add(key); act(() => game.setVeil([...v]), "Veil set; it applies once a block includes it."); };
  return (
    <div className="panel you" aria-label="You">
      <div className="you-head">
        <Flag view={view} palette={palette} name={state.names[me] ?? "You"} size={112} badge={!!state.fresh.anon} names={state.names} me={me} steps={steps}
              labels={labels} onHistory={(v, e) => { game.clearFresh("anon"); onHistory(me, v, e); }} title={`your flag, ${view.filter((v) => !v.lifted && v.alpha > 0).length} stripes`} />
        <div className="you-meta">
          <div className="you-name">{state.names[me] ?? "You"}</div>
          {p ? (
            <div className="toggle" role="radiogroup" aria-label="flag visibility">
              {["public", "private"].map((f) => (
                <button key={f} role="radio" aria-checked={p.flag === f} className={p.flag === f ? "on" : ""} disabled={busy || closed || p.flag === f}
                        onClick={() => act(() => game.setVisibility(f), f === "public" ? "Going public: the colours on your flag are disclosed from now on." : "Going private: new inks on you are sealed.")}>{f}</button>
              ))}
            </div>
          ) : <div className="small muted">{game.isParticipant ? "not entered yet" : "watching"}</div>}
        </div>
      </div>
      {p && <p className="small muted">{reach}</p>}
      {p && (editing ? (
        <div className="record-row">
          <input aria-label="tags" value={tagText} placeholder="up to 12 tags, separated by commas" onChange={(e) => setTagText(e.target.value)} />
          <button className="small" disabled={busy || !tagsOk(parseTags(tagText))} onClick={() => act(() => game.setTags(parseTags(tagText))).then(() => setEditing(false))}>Save</button>
          <button className="ghost small" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <div className="tags">
          {(p.tags ?? []).map((t) => <span key={t} className="tag">{t}</span>)}
          {!p.tags?.length && <span className="small muted">no tags</span>}
          {!closed && <button className="ghost small" onClick={() => { setTagText((p.tags ?? []).join(", ")); setEditing(true); }}>edit</button>}
        </div>
      ))}
      {p && (
        <div className="record-row">
          <label className="small check"><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> names</label>
          {p.flag === "public" && view.length > 0 && !closed && <button className="ghost small" aria-expanded={veiling} onClick={() => setVeiling(!veiling)}>{veiling ? "Done" : `Veil (${veil.size})`}</button>}
        </div>
      )}
      {veiling && (
        <ul className="veil-list" aria-label="veil stripes from others">
          {view.filter((v) => !v.lifted).map((v) => (
            <li key={v.key}>
              <label className="check small">
                <input type="checkbox" checked={veil.has(v.key)} disabled={busy} onChange={() => toggleVeil(v.key)} />
                <span className="sw" style={{ background: v.colour === null ? "#333" : palette[v.colour] }} />
                {v.by ? state.names[v.by] ?? v.by.slice(0, 8) : "anonymous"}{v.colour !== null ? ` · ${v.colour + 1}` : ""}
              </label>
            </li>
          ))}
          <li className="small muted">Veiled stripes keep their place; others see them without colour.</li>
        </ul>
      )}
      {msg && <p className="small muted" role="status">{msg}</p>}
    </div>
  );
}

/** Entering the round (D1): the player chooses public or private; nothing is preselected. */
export function Entry({ game, state }) {
  const [flag, setFlag] = useState(null);
  const [tagText, setTagText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const tags = parseTags(tagText);
  const n = Object.keys(state.players).length, pub = Object.values(state.players).filter((p) => p.flag === "public").length;
  const go = async () => {
    setBusy(true); setErr(null);
    try { await game.enter(flag, tags); await game.refresh(); } catch (e) { setErr(e.message ?? String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="entry-wrap" role="dialog" aria-modal="true" aria-labelledby="entry-title">
      <div className="panel entry">
        <div className="eyebrow">F1R3Ink</div>
        <h2 id="entry-title">Enter the round</h2>
        <p>Players ink one another with colour. Each person who inks you holds one stripe on your flag, and its colour can change as their view of you changes.</p>
        <p className="small muted">{n} {n === 1 ? "player has" : "players have"} entered; {pub} {pub === 1 ? "flag is" : "flags are"} public.</p>
        <fieldset>
          <legend>Who sees your flag?</legend>
          <label className="radio">
            <input type="radio" name="flag" checked={flag === "public"} onChange={() => setFlag("public")} />
            <strong>Public</strong> <span className="muted">Everyone sees your flag in full and who inked it. Your flag counts toward the community spectrum.</span>
          </label>
          <label className="radio">
            <input type="radio" name="flag" checked={flag === "private"} onChange={() => setFlag("private")} />
            <strong>Private</strong> <span className="muted">Inks on you are sealed to you and their inker. Only you see your whole flag.</span>
          </label>
        </fieldset>
        <label>
          Tags (optional; how you want to be seen today, up to 12)
          <input aria-label="entry tags" value={tagText} placeholder="tired, hopeful, new here" onChange={(e) => setTagText(e.target.value)} />
        </label>
        <p className="small muted">You can change either at any time. Going public later discloses the current colours on your flag; going private seals new inks from then on.</p>
        <button disabled={!flag || busy || !tagsOk(tags)} onClick={go}>{busy ? "Entering…" : "Enter"}</button>
        {err && <p className="small warn" role="alert">{err}</p>}
      </div>
    </div>
  );
}
