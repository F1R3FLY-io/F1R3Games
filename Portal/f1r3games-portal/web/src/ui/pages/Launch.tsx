import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Async } from "../components/Async";
import type { Visibility } from "../../core/portal";
import { useLoad, usePortal } from "../PortalContext";
import { message } from "../util";

const VIS: { v: Visibility; label: string; help: string }[] = [
  { v: "unlisted", label: "Unlisted", help: "Not shown in listings; anyone with the link can join." },
  { v: "public", label: "Public", help: "Listed under the game; anyone can join." },
  { v: "private", label: "Private", help: "Only people you invite can join." },
];

export function Launch() {
  const { id = "" } = useParams();
  const portal = usePortal();
  const nav = useNavigate();
  const game = useLoad((p) => p.game(id), [id]);
  const [visibility, setVisibility] = useState<Visibility>("unlisted");
  const [budget, setBudget] = useState(5_000_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!portal.signedOn) return <p>Sign on to launch a game.</p>;
  return (
    <Async state={game}>
      {(g) => (
        <section className="panel narrow">
          <h1>Launch {g.name}</h1>
          <fieldset>
            <legend>Who can join</legend>
            {VIS.map((o) => (
              <label key={o.v} className="radio">
                <input type="radio" name="vis" value={o.v} checked={visibility === o.v} onChange={() => setVisibility(o.v)} />
                <strong>{o.label}</strong> <span className="muted">{o.help}</span>
              </label>
            ))}
          </fieldset>
          <label>
            Play allowance (phlo the game may spend without asking, for four hours)
            <input type="number" min={0} step={100000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          </label>
          {error && <p className="error">{error}</p>}
          <button
            disabled={!!busy}
            onClick={async () => {
              setError(null);
              try {
                setBusy("Waiting for your approval…");
                const r = await portal.launch(id, visibility);
                portal.enterGame(g, r.instanceId, budget);
                setBusy("Waiting for the shard to include it…");
                await portal.waitFor(r.deployId);
                nav(`/instances/${r.instanceId}?new=1`);
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy ?? "Launch"}
          </button>
        </section>
      )}
    </Async>
  );
}
