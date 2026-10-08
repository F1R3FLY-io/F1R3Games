import { useEffect, useState } from "react";
import { isAnon, sidKey } from "../core/ink.js";

/**
 * The ink control for the one selected player (§11): the round's palette,
 * numbered (D4), the attribution toggle for a new stripe (D2), and Ink;
 * for an existing stripe, Refresh (same colour, D3), Lift and, for an
 * anonymous stripe, Reveal.
 */
export function InkControl({ game, state, target }) {
  const palette = state.round?.palette ?? [];
  const them = state.players[target];
  const mineStripe = game.myStripe(target);
  const myView = them ? game.view(target).find((v) => v.mine) : null;
  const current = myView?.colour ?? null;
  const [colour, setColour] = useState(current);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setColour(current); setMsg(null); setConfirming(false); }, [target, current]);
  const cfg = state.round;
  const present = Object.values(state.players).filter((p) => !p.left).length;
  const anonAllowed = !!cfg?.anonymous && !!cfg?.relay && present >= (cfg?.anonMin ?? 5);
  const anonStripe = mineStripe ? isAnon(sidKey(mineStripe.sid)) : false;
  const active = game.status === "active";
  const name = state.names[target] ?? target.slice(0, 10);
  const act = async (f, done) => {
    setBusy(true); setMsg(null);
    try { const r = await f(); setMsg(r?.queued === true && !r.handle ? "Queued after your ink in flight." : done); }
    catch (e) { setMsg(e.message ?? String(e)); }
    finally { setBusy(false); }
  };
  const pending = state.pending?.target === target;
  const left = game.stepsLeft(target);
  const steps = cfg?.decay?.steps ?? null;
  if (!them) return <div className="panel ink-control"><span className="small muted">{name} has not entered the round.</span></div>;
  return (
    <div className="panel ink-control" aria-label={`ink ${name}`}>
      <div className="cc-head">
        <span className="eyebrow">Ink {name}</span>
        <span className="small muted">{them.flag === "private" ? "private flag: sealed to them and you" : "public flag: everyone sees it"}</span>
      </div>
      <div className="swatches" role="radiogroup" aria-label="palette">
        {palette.map((hex, i) => (
          <button key={hex} role="radio" aria-checked={colour === i} aria-label={`colour ${i + 1}, ${hex}`} title={`${i + 1} · ${hex}`}
                  className={`swatch${colour === i ? " on" : ""}${current === i ? " current" : ""}`} style={{ background: hex, color: contrast(hex) }}
                  disabled={!active || busy} onClick={() => setColour(i)}>{i + 1}</button>
        ))}
      </div>
      {!mineStripe ? (
        <div className="toggle" role="radiogroup" aria-label="attribution">
          <button role="radio" aria-checked={!anonymous} className={!anonymous ? "on" : ""} onClick={() => setAnonymous(false)}>attributed</button>
          <button role="radio" aria-checked={anonymous} className={anonymous ? "on" : ""} disabled={!anonAllowed} onClick={() => setAnonymous(true)}
                  title={anonAllowed ? "" : cfg?.anonymous ? `needs ${cfg.anonMin} players and the relay` : "this round does not allow anonymous ink"}>anonymous</button>
        </div>
      ) : (
        <p className="small muted">{anonStripe ? "Your stripe on them is anonymous." : "Your stripe on them is attributed to you."}{left !== null ? ` ${left} of ${steps} steps left.` : ""}</p>
      )}
      {anonymous && !mineStripe && (
        <p className="small muted">Hidden from every player and every reader of the shard, but not from the F1R3FLY.io Cooperative, whose relay sends it (D10).</p>
      )}
      <div className="record-row">
        <button disabled={!active || busy || colour === null || pending} onClick={() => act(() => game.ink(target, colour, { anonymous }), anonymous || anonStripe ? "Sent to the relay; it lands with the next batch." : "Inked; it settles when a block includes it.")}>
          {mineStripe ? (colour === current ? "Refresh" : "Change") : "Ink"}
        </button>
        {mineStripe && myView && !myView.lifted && <button className="ghost small" disabled={!active || busy || pending} onClick={() => act(() => game.ink(target, null), "Lifted; your stripe keeps its place, without colour.")}>Lift</button>}
        {anonStripe && !confirming && <button className="ghost small" disabled={busy || game.status === "closed"} onClick={() => setConfirming(true)}>Reveal…</button>}
      </div>
      {confirming && (
        <div className="record-row confirm" role="alertdialog" aria-label="confirm reveal">
          <span className="small">Show {name} and everyone that this stripe is yours? There is no way back.</span>
          <button className="small" disabled={busy} onClick={() => { setConfirming(false); act(() => game.reveal(target), "Revealed: the stripe now carries your name."); }}>Reveal</button>
          <button className="ghost small" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      {pending && <p className="small">inking {state.pending.colour === null ? "a lift" : `colour ${state.pending.colour + 1}`}…{state.queued?.target === target ? ` then ${state.queued.colour === null ? "a lift" : `colour ${state.queued.colour + 1}`}` : ""}</p>}
      {!active && <p className="small muted">{game.status === "closed" ? "The round is closed." : "Inking opens when the host starts the round."}</p>}
      {msg && <p className="small muted" role="status">{msg}</p>}
    </div>
  );
}

/** Black or white text on a swatch. */
export function contrast(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";
}
