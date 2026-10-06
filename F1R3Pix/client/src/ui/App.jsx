import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Board } from "./Board.jsx";
import { ColourControl } from "./ColourControl.jsx";
import { Tokens } from "./Tokens.jsx";
import { Players } from "./Players.jsx";
import { Record } from "./Record.jsx";
import { key } from "../core/hex.js";

function useGame(game) {
  return useSyncExternalStore((f) => game.subscribe(f), () => game.state);
}

export function App({ game, demo = false }) {
  const state = useGame(game);
  const [selected, setSelected] = useState(new Set());
  const [painting, setPainting] = useState(false);
  const [recent, setRecent] = useState([]);
  const [tab, setTab] = useState("board");
  const [frame, setFrame] = useState(null);
  const [showRecord, setShowRecord] = useState(false);
  useEffect(() => { game.start().then(() => game.startPolling()); return () => game.stopPolling(); }, [game]);
  const toggle = (a) => { if (!a || a === state.me?.address) return; setSelected((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; }); };
  const status = state.board?.status ?? state.instance?.status;
  const mineCell = game.myCell && state.board?.cells.get(key(...game.myCell));
  const pick = async (c) => {
    setRecent((r) => [c, ...r.filter((x) => x !== c)].slice(0, 8));
    try { await game.paint(c); } catch (e) { game.set({ notice: e.message ?? String(e) }); }
  };
  const claim = async (cell) => { try { await game.ensureSeat(cell); } catch (e) { game.set({ notice: e.message ?? String(e) }); } };
  useEffect(() => { if (status === "closed") setShowRecord(true); }, [status]);

  if (state.phase === "loading") return <div className="splash"><div className="eyebrow">F1R3Pix</div><p>Connecting to the Portal…</p></div>;
  if (state.phase === "error") return <div className="splash"><div className="eyebrow">F1R3Pix</div><p className="warn">{state.error}</p></div>;

  return (
    <div className={`app tab-${tab}`}>
      <header className="top">
        <span className="wordmark">F1R3Pix</span>
        <span className={`status ${status}`}>{status}</span>
        <span className="small muted">{game.capacityLine}</span>
        {demo && <span className="small demo">demo: an in-memory shard with simulated players</span>}
        <span className="spacer" />
        {status === "lobby" && <span className="small muted">{game.isHost ? "Start the game from the Portal's instance page when everyone is seated." : "Waiting for the host to start. You can talk and make deals now."}</span>}
        <button className="ghost small" onClick={() => setShowRecord((v) => !v)}>{showRecord ? "Hide replay" : "Replay"}</button>
      </header>
      <nav className="tabs" aria-label="columns">
        {["tokens", "board", "players"].map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <main className="cols">
        <Tokens game={game} state={state} selected={selected} names={state.names} me={state.me?.address} />
        <section className="col col-centre" aria-label="Board">
          <Board game={game} state={state} selected={selected} onToggle={toggle} names={state.names} frame={frame}
                 onOwnCell={() => setPainting(true)} onClaim={claim} />
          {painting && (
            <ColourControl current={state.pending?.colour ?? mineCell?.colour} palette={state.board?.palette} recent={recent}
                           disabled={status !== "active"} onPick={pick} onClose={() => setPainting(false)} />
          )}
          <div className="board-foot">
            {state.pending && <span className="small">painting {state.pending.colour}… {state.queued ? `then ${state.queued}` : ""}</span>}
            {!game.myCell && game.isParticipant && status !== "closed" && state.board?.seating === "random" && <span className="small">Taking a seat…</span>}
            {game.myCell && status === "active" && !painting && <button className="small" onClick={() => setPainting(true)}>Paint your cell</button>}
            {state.notice && <span className="small muted" role="status">{state.notice}</span>}
          </div>
          {showRecord && <Record game={game} state={state} onFrame={setFrame} />}
        </section>
        <Players game={game} state={state} selected={selected} onToggle={toggle} onClear={() => setSelected(new Set())} names={state.names} />
      </main>
    </div>
  );
}
