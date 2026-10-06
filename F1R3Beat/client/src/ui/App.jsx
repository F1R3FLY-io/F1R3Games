import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Grid } from "./Grid.jsx";
import { NoteControl } from "./NoteControl.jsx";
import { Transport } from "./Transport.jsx";
import { Tokens } from "./Tokens.jsx";
import { Players } from "./Players.jsx";
import { Record } from "./Record.jsx";
import { Gallery } from "./Gallery.jsx";
import { LoopPlayer } from "../core/audio.js";
import { rowOf } from "../core/grid.js";

function useGame(game) {
  return useSyncExternalStore((f) => game.subscribe(f), () => game.state);
}

export function App({ game, demo = false, player: givenPlayer = null }) {
  const state = useGame(game);
  const [selected, setSelected] = useState(new Set());
  const [choosing, setChoosing] = useState(false);
  const [tab, setTab] = useState("grid");
  const [frame, setFrame] = useState(null);
  const [panel, setPanel] = useState(null); // "record" | "gallery" | null
  const [step, setStep] = useState(null);
  const player = useMemo(() => givenPlayer ?? new LoopPlayer({ onStep: setStep }), [givenPlayer]);
  useEffect(() => { game.start().then(() => game.startPolling()); return () => { game.stopPolling(); player.stop(); }; }, [game]);
  const status = state.grid?.status ?? state.instance?.status;
  const pattern = game.pattern;
  useEffect(() => { if (pattern) player.setPattern(frame ? { shape: pattern.shape, cells: pattern.cells.map((_, c) => frame.get(c) ?? null) } : pattern); }, [pattern, frame]);
  useEffect(() => { player.setTempo(game.tempo); }, [state.tempo, state.seats, state.grid]);
  useEffect(() => { if (status === "closed") setPanel("record"); }, [status]);
  const toggle = (a) => { if (!a || a === state.me?.address) return; setSelected((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; }); };
  const pick = async (note) => { try { await game.setNote(note); } catch (e) { game.set({ notice: e.message ?? String(e) }); } };
  const claim = async (want) => { try { await game.ensureSeat(want); } catch (e) { game.set({ notice: e.message ?? String(e) }); } };
  const mine = game.myCell;

  if (state.phase === "loading") return <div className="splash"><div className="eyebrow">F1R3Beat</div><p>Connecting to the Portal…</p></div>;
  if (state.phase === "error") return <div className="splash"><div className="eyebrow">F1R3Beat</div><p className="warn">{state.error}</p></div>;

  return (
    <div className={`app tab-${tab}`}>
      <header className="top">
        <span className="wordmark">F1R3Beat</span>
        <span className={`status ${status}`}>{status}</span>
        <span className="small muted">{game.capacityLine}</span>
        {demo && <span className="small demo">demo: an in-memory shard with simulated players</span>}
        <span className="spacer" />
        {status === "lobby" && <span className="small muted">{game.isHost ? "Start the game from the Portal's instance page when everyone is seated." : "Waiting for the host to start. You can talk and make deals now."}</span>}
        <button className="ghost small" onClick={() => setPanel(panel === "gallery" ? null : "gallery")}>{panel === "gallery" ? "Hide gallery" : "Gallery"}</button>
        <button className="ghost small" onClick={() => setPanel(panel === "record" ? null : "record")}>{panel === "record" ? "Hide replay" : "Replay"}</button>
      </header>
      <nav className="tabs" aria-label="columns">
        {["tokens", "grid", "players"].map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <main className="cols">
        <Tokens game={game} state={state} selected={selected} names={state.names} me={state.me?.address} />
        <section className="col col-centre" aria-label="Grid">
          <Transport game={game} state={state} player={player} pattern={pattern} />
          <Grid game={game} state={state} selected={selected} onToggle={toggle} names={state.names} frame={frame} playhead={step}
                onOwnCell={() => setChoosing(true)} onClaim={claim} />
          {choosing && mine !== null && (
            <NoteControl row={rowOf(mine)} current={state.pending ? state.pending.note : game.noteOf(mine)} scale={state.grid?.scale}
                         disabled={status !== "active"} onPick={pick} onClose={() => setChoosing(false)} />
          )}
          <div className="board-foot">
            {state.pending && <span className="small">setting {state.pending.note ?? "nothing"}… {state.queued ? `then ${state.queued.note ?? "nothing"}` : ""}</span>}
            {mine === null && game.isParticipant && status !== "closed" && state.grid?.seating === "random" && <span className="small">Taking a seat…</span>}
            {mine !== null && status === "active" && !choosing && <button className="small" onClick={() => setChoosing(true)}>Play your cell</button>}
            {state.notice && <span className="small muted" role="status">{state.notice}</span>}
          </div>
          {panel === "record" && <Record game={game} state={state} onFrame={setFrame} />}
          {panel === "gallery" && <Gallery game={game} state={state} player={player} />}
        </section>
        <Players game={game} state={state} selected={selected} onToggle={toggle} onClear={() => setSelected(new Set())} names={state.names} />
      </main>
    </div>
  );
}
