import { useMemo, useState } from "react";
import { frames } from "../core/history.js";
import { FlagsAt } from "./Record.jsx";
import { spanOf } from "../core/game.js";

/**
 * A published play, replayed by block: a `round` shows every public flag
 * (veiled stripes without colour, sealed ones hatched unless disclosed); a
 * `flag` portrait shows its owner's flag with the colours its keys disclose.
 */
export function Replay({ kind, decoded, title = null, names = {} }) {
  const round = kind === "flag" ? decoded.round : decoded;
  const owner = kind === "flag" ? decoded.owner : null;
  const fs = useMemo(() => frames(round.events), [round]);
  const [at, setAt] = useState(Infinity);
  const i = fs.length ? Math.min(at, fs.length - 1) : 0;
  // A portrait's events all concern its owner; show the owner's flag even while private.
  const events = useMemo(() => (owner ? round.events.map((e) => (e.type === "visibility" && e.player === owner ? { ...e, public: true } : e)) : round.events), [round, owner]);
  const inks = round.events.filter((e) => e.type === "ink").length;
  return (
    <div className="replay">
      <div className="eyebrow">{title ?? (kind === "flag" ? "F1R3Ink portrait" : "F1R3Ink round")}</div>
      <p className="small muted">
        blocks {round.from}–{round.to - 1} · {inks} inks{kind === "flag" ? ` · ${decoded.keys.length} disclosed` : ""}
        {round.decay ? ` · fades over ${spanOf(round.decay.unit * round.decay.steps)}` : " · no fading"}
      </p>
      {fs.length ? (
        <>
          <FlagsAt events={events} h={fs[i]} palette={round.palette} decay={round.decay} names={names} size={kind === "flag" ? 120 : 56} />
          {fs.length > 1 && (
            <div className="record-row">
              <input type="range" min={0} max={fs.length - 1} value={i} aria-label="block" onChange={(e) => setAt(Number(e.target.value))} />
              <span className="small muted">block {fs[i]}</span>
            </div>
          )}
        </>
      ) : <p className="small muted">This span holds no events.</p>}
    </div>
  );
}
