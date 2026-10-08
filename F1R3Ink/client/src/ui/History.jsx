import { useEffect, useRef, useState } from "react";
import { describeStripe } from "./Flag.jsx";

const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A stripe's colour history (D3), newest first: opened by right-click, long-press or Enter on the stripe. */
export function History({ game, state, at, onClose }) {
  const { target, stripe, x, y } = at;
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState(null);
  const box = useRef(null);
  const palette = state.round?.palette ?? [];
  useEffect(() => { game.stripeHistory(target, stripe.key).then(setEntries).catch((e) => setErr(e.message ?? String(e))); }, [target, stripe.key, stripe.seq]);
  useEffect(() => {
    box.current?.focus();
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const owner = target === state.me?.address ? "your flag" : `${state.names[target] ?? target.slice(0, 10)}'s flag`;
  const style = x !== undefined ? { left: Math.min(x, (window.innerWidth || 800) - 300), top: Math.min(y, (window.innerHeight || 600) - 260) } : {};
  return (
    <div className="popover-back" onClick={onClose}>
      <div className="panel popover" role="dialog" aria-label="stripe history" tabIndex={-1} ref={box} style={style} onClick={(e) => e.stopPropagation()}>
        <div className="cc-head">
          <span className="eyebrow">Stripe history</span>
          <button className="ghost small" onClick={onClose} aria-label="close">✕</button>
        </div>
        <p className="small">{describeStripe(stripe, { palette, names: state.names, me: state.me?.address, steps: state.round?.decay?.steps })} · on {owner}</p>
        {err && <p className="small warn">{err}</p>}
        {!entries && !err && <p className="small muted">Reading the history…</p>}
        {entries && (
          <ol className="history">
            {entries.map((e) => (
              <li key={e.seq}>
                <span className="sw" style={{ background: e.colour === null ? (e.lifted ? "transparent" : "#333") : palette[e.colour] }} />
                <span>{e.lifted ? "lifted" : e.colour === null ? (stripe.veiled ? "veiled" : "sealed") : `${e.colour + 1} · ${palette[e.colour]}`}</span>
                <span className="small muted">block {e.h} · {when(e.t)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
