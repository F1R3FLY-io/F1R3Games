import { useState } from "react";
import { Flag } from "./Flag.jsx";
import { InkControl } from "./InkControl.jsx";
import { Spectrum, Trend } from "./Aggregates.jsx";
import { seesFull } from "../core/flags.js";

/**
 * Right column (§11): everyone else. A vertical wheel of the other entered
 * players, each avatar carrying the stripes the viewer may see; selecting
 * drives messages and payments, and selecting exactly one opens the ink
 * control. The header switches to the Spectrum and Trend views (D13).
 */
export function Others({ game, state, selected, onToggle, onClear, onHistory, labels }) {
  const [mode, setMode] = useState("flags");
  const [order, setOrder] = useState("recent");
  const [focus, setFocus] = useState(0);
  const me = state.me?.address;
  const list = game.wheel(order);
  const palette = state.round?.palette ?? [];
  const steps = state.round?.decay?.steps ?? null;
  const one = selected.size === 1 ? [...selected][0] : null;
  const onWheel = (e) => { if (!list.length) return; setFocus((f) => Math.max(0, Math.min(list.length - 1, f + Math.sign(e.deltaY)))); };
  const line = (a) => {
    const p = state.players[a];
    const view = game.view(a);
    const shown = view.filter((v) => !v.lifted && v.alpha > 0);
    const full = seesFull({ viewer: me, target: a, players: state.players, reciprocity: !!state.round?.reciprocity });
    const mine = view.find((v) => v.mine);
    const fading = mine && mine.remaining !== null && steps && mine.remaining < steps / 3;
    const parts = [p.flag, full ? `${shown.length} stripe${shown.length === 1 ? "" : "s"}` : mine ? "your stripe only" : "no stripe of yours"];
    if (fading) parts.push("yours fading");
    if (p.tags?.length) parts.push(p.tags.slice(0, 3).join(", "));
    return parts.join(" · ");
  };
  return (
    <section className="col col-right" aria-label="Players">
      <div className={`panel wheel-panel${mode === "flags" ? "" : " compact"}`}>
        <div className="wheel-head">
          <div className="toggle views" role="tablist" aria-label="view">
            {["flags", "spectrum", "trend"].map((m) => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{m}</button>)}
          </div>
          {mode === "flags" && (
            <select aria-label="order" value={order} onChange={(e) => setOrder(e.target.value)}>
              <option value="recent">recent</option><option value="name">name</option><option value="newest">newest on you</option>
            </select>
          )}
          <button className="ghost small" onClick={() => game.bridge.invite?.().catch(() => {})}>Invite</button>
        </div>
        {mode === "flags" && (
          <ul className="wheel" onWheel={onWheel} aria-label="players, select any number">
            {list.map((a, i) => {
              const d = Math.abs(i - focus);
              const scale = Math.max(0.6, 1 - d * 0.1);
              const on = selected.has(a);
              const full = seesFull({ viewer: me, target: a, players: state.players, reciprocity: !!state.round?.reciprocity });
              return (
                <li key={a} style={{ transform: `scale(${scale})`, opacity: Math.max(0.5, 1 - d * 0.08) }}>
                  <div className={`wheel-item${on ? " on" : ""}`}>
                    <Flag view={game.view(a)} palette={palette} name={state.names[a]} size={56} locked={!full} badge={!!state.fresh[a]} names={state.names} me={me}
                          steps={steps} labels={labels} onHistory={(v, e) => onHistory(a, v, e)} />
                    <button className="wheel-pick" aria-pressed={on} onClick={() => { setFocus(i); game.clearFresh(a); onToggle(a); }}>
                      <span className="wheel-name">{state.names[a] ?? a.slice(0, 10)}</span>
                      <span className="small muted wheel-sub">{line(a)}</span>
                    </button>
                  </div>
                </li>
              );
            })}
            {list.length === 0 && <li className="muted small">No one else has entered yet. Invite someone.</li>}
          </ul>
        )}
        {mode === "flags" && selected.size > 0 && <button className="ghost small" onClick={onClear}>Clear selection ({selected.size})</button>}
      </div>
      {mode === "spectrum" && <Spectrum game={game} state={state} />}
      {mode === "trend" && <Trend game={game} state={state} target={one ?? me} />}
      {mode === "trend" && !one && <p className="small muted">Showing your own flag. Select one player to see theirs.</p>}
      {mode === "flags" && one && game.entered && <InkControl game={game} state={state} target={one} />}
      {mode === "flags" && selected.size > 1 && <p className="small muted">{selected.size} selected: write to them or pay them on the left. Select one to ink.</p>}
    </section>
  );
}
