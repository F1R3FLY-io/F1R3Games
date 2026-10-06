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
  // F1R3Pix instance configuration (design §5.1), fixed at creation.
  const [capacity, setCapacity] = useState(61);
  const [seating, setSeating] = useState<"random" | "claim">("random");
  const [palette, setPalette] = useState("");
  const [messageLimit, setMessageLimit] = useState(2048);
  const pixConfig = () => {
    const cols = palette.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase());
    if (!Number.isInteger(capacity) || capacity < 7 || capacity > 469) throw new Error("capacity must be 7 to 469");
    if (cols.length > 32 || cols.some((c) => !/^#[0-9A-F]{6}$/.test(c))) throw new Error("the palette is up to 32 colours written #RRGGBB");
    if (!Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 65536) throw new Error("the message limit is 1 to 65536 bytes");
    return { capacity, seating, palette: cols.length ? cols : null, messageLimit };
  };

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
          {g.id === "f1r3pix" && (
            <fieldset>
              <legend>The board</legend>
              <label>
                Players (7 to 469; the board is the smallest hexagon that seats them, and empty cells stay void)
                <input type="number" min={7} max={469} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
              </label>
              <label className="radio">
                <input type="radio" name="seating" checked={seating === "random"} onChange={() => setSeating("random")} />
                <strong>Random seats</strong> <span className="muted">Neighbours who have never met must still negotiate.</span>
              </label>
              <label className="radio">
                <input type="radio" name="seating" checked={seating === "claim"} onChange={() => setSeating("claim")} />
                <strong>Players choose</strong> <span className="muted">For friends and set formations.</span>
              </label>
              <label>
                Palette (optional, up to 32 colours such as #F3D630 #3FA9F5; empty means any colour)
                <input value={palette} onChange={(e) => setPalette(e.target.value)} />
              </label>
              <label>
                Largest sealed message, in bytes
                <input type="number" min={1} max={65536} value={messageLimit} onChange={(e) => setMessageLimit(Number(e.target.value))} />
              </label>
            </fieldset>
          )}
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
                const config = g.id === "f1r3pix" ? pixConfig() : {};
                const r = await portal.launch(id, visibility, config);
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
