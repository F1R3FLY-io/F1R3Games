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
  // F1R3Beat instance configuration (design v2 §5.1), fixed at creation.
  const [meter, setMeter] = useState("4/4");
  const [bars, setBars] = useState(2);
  const [column, setColumn] = useState(16);
  const [beatCapacity, setBeatCapacity] = useState(32);
  const [beatSeating, setBeatSeating] = useState<"random" | "row" | "claim">("random");
  const [scaleKind, setScaleKind] = useState("");
  const [tonic, setTonic] = useState("E");
  const [tempo, setTempo] = useState(100);
  const beatConfig = () => {
    const m = /^(\d+)\/(\d+)$/.exec(meter.trim());
    const n = m ? Number(m[1]) : NaN, d = m ? Number(m[2]) : NaN;
    if (!m || n < 1 || n > 32 || ![2, 4, 8, 16].includes(d)) throw new Error("the meter is n/d with d 2, 4, 8 or 16");
    if ((n * column) % d !== 0) throw new Error(`${meter} does not divide into whole columns of 1/${column}`);
    const steps = (bars * n * column) / d;
    if (!Number.isInteger(bars) || bars < 1 || steps > 64) throw new Error(`${bars} bars of ${meter} in 1/${column} is ${steps} columns; at most 64`);
    if (!Number.isInteger(beatCapacity) || beatCapacity < 1 || beatCapacity > 5 * steps) throw new Error(`players must be 1 to ${5 * steps}`);
    if (!Number.isInteger(tempo) || tempo < 40 || tempo > 240) throw new Error("the default tempo is 40 to 240 bpm");
    if (!Number.isInteger(messageLimit) || messageLimit < 1 || messageLimit > 65536) throw new Error("the message limit is 1 to 65536 bytes");
    return { meter: [n, d], bars, column: [1, column], capacity: beatCapacity, seating: beatSeating,
             scale: scaleKind ? [scaleKind, tonic] : null, tempo, seed: null, messageLimit };
  };
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
          {g.id === "f1r3beat" && (
            <fieldset>
              <legend>The grid</legend>
              <label>
                Time signature
                <input value={meter} onChange={(e) => setMeter(e.target.value)} />
              </label>
              <label>
                Bars
                <input type="number" min={1} max={16} value={bars} onChange={(e) => setBars(Number(e.target.value))} />
              </label>
              <label>
                Column (the subdivision of the beat; every note lasts one column)
                <select value={column} onChange={(e) => setColumn(Number(e.target.value))}>
                  {[[4, "quarter"], [8, "eighth"], [16, "sixteenth"], [32, "thirty-second"], [6, "quarter triplet"], [12, "eighth triplet"], [24, "sixteenth triplet"]].map(([k, l]) => (
                    <option key={k} value={k}>1/{k} · {l}</option>
                  ))}
                </select>
              </label>
              <label>
                Players (empty cells stay silent)
                <input type="number" min={1} max={320} value={beatCapacity} onChange={(e) => setBeatCapacity(Number(e.target.value))} />
              </label>
              {([["random", "Random seats", "Neighbours who have never met must still negotiate."],
                 ["row", "Players choose an instrument", "The step within the row is drawn for them."],
                 ["claim", "Players choose a cell", "For friends and set formations."]] as const).map(([v, label, help]) => (
                <label key={v} className="radio">
                  <input type="radio" name="beatSeating" checked={beatSeating === v} onChange={() => setBeatSeating(v)} />
                  <strong>{label}</strong> <span className="muted">{help}</span>
                </label>
              ))}
              <label>
                Scale for the pitched rows (optional)
                <select value={scaleKind} onChange={(e) => setScaleKind(e.target.value)}>
                  <option value="">any pitch</option>
                  {["major", "minor", "dorian", "pentatonic", "minor-pentatonic", "blues", "chromatic"].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                {scaleKind && (
                  <select value={tonic} onChange={(e) => setTonic(e.target.value)} aria-label="tonic">
                    {["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
              </label>
              <label>
                Default tempo (each player can listen at their own)
                <input type="number" min={40} max={240} value={tempo} onChange={(e) => setTempo(Number(e.target.value))} />
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
                const config = g.id === "f1r3pix" ? pixConfig() : g.id === "f1r3beat" ? beatConfig() : {};
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
