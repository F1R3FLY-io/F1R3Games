import { useEffect, useState, useSyncExternalStore } from "react";
import { You, Entry } from "./You.jsx";
import { Messages } from "./Messages.jsx";
import { Tokens } from "./Tokens.jsx";
import { Others } from "./Others.jsx";
import { History } from "./History.jsx";
import { Record } from "./Record.jsx";
import { Gallery } from "./Gallery.jsx";

function useGame(game) {
  return useSyncExternalStore((f) => game.subscribe(f), () => game.state);
}

/** Re-render between blocks so opacity follows the clock (R-now); decay itself runs on block time. */
function useTick(ms) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
}

/**
 * Two columns (design §11, Figure 8): you on the left, with your flag, tags,
 * visibility, then messages and tokens; everyone else on the right, as a
 * wheel that can switch to the aggregate views, with the ink control for
 * the one selected player. Below 900 px the columns become tabs.
 */
export function App({ game, demo = false }) {
  const state = useGame(game);
  const [selected, setSelected] = useState(new Set());
  const [tab, setTab] = useState("players");
  const [panel, setPanel] = useState(null); // "record" | "gallery" | null
  const [history, setHistory] = useState(null);
  const [labels, setLabels] = useState(false);
  useTick(15_000);
  useEffect(() => { game.start().then(() => game.startPolling()); return () => game.stopPolling(); }, [game]);
  const status = game.status;
  useEffect(() => { if (status === "closed") setPanel("record"); }, [status]);
  const toggle = (a) => { if (!a || a === state.me?.address) return; setSelected((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n; }); };
  const onHistory = (target, stripe, e) => setHistory({ target, stripe, x: e?.clientX, y: e?.clientY });

  if (state.phase === "loading") return <div className="splash"><div className="eyebrow">F1R3Ink</div><p>Connecting to the Portal…</p></div>;
  if (state.phase === "error") return <div className="splash"><div className="eyebrow">F1R3Ink</div><p className="warn">{state.error}</p></div>;

  return (
    <div className={`app tab-${tab}`}>
      <header className="top">
        <span className="wordmark">F1R3Ink</span>
        <span className={`status ${status}`}>{status}</span>
        <span className="small muted">{game.capacityLine}</span>
        {demo && <span className="small demo">demo: an in-memory shard with simulated players</span>}
        <span className="spacer" />
        {status === "lobby" && <span className="small muted">{game.isHost ? "Start the round from the Portal's instance page when people have entered." : "Waiting for the host to start. You can enter, talk and pay now."}</span>}
        {state.notice && <span className="small muted" role="status">{state.notice}</span>}
        <button className="ghost small" onClick={() => setPanel(panel === "gallery" ? null : "gallery")}>{panel === "gallery" ? "Hide gallery" : "Gallery"}</button>
        <button className="ghost small" onClick={() => setPanel(panel === "record" ? null : "record")}>{panel === "record" ? "Hide replay" : "Replay"}</button>
      </header>
      <nav className="tabs" aria-label="columns">
        {["you", "players"].map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      {panel && (
        <div className="drawer">
          {panel === "record" && <Record game={game} state={state} />}
          {panel === "gallery" && <Gallery game={game} state={state} />}
        </div>
      )}
      <main className="cols">
        <section className="col col-left" aria-label="You and your conversations">
          <You game={game} state={state} onHistory={onHistory} labels={labels} setLabels={setLabels} />
          <Messages game={game} state={state} selected={selected} names={state.names} />
          <Tokens game={game} state={state} selected={selected} names={state.names} me={state.me?.address} />
        </section>
        <Others game={game} state={state} selected={selected} onToggle={toggle} onClear={() => setSelected(new Set())} onHistory={onHistory} labels={labels} />
      </main>
      {game.needsEntry && <Entry game={game} state={state} />}
      {history && <History game={game} state={state} at={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
