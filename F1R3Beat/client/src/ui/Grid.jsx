import { useState } from "react";
import { ROWS, cellIndex, describeCell, rowOf } from "../core/grid.js";

/**
 * The grid (design §8.1): rows by instrument, bar lines heavy, beat lines
 * medium, columns light. Sounding cells carry their note's name. Your cell: a
 * white outline and a dot. Selected players: a sky outline that pulses. Void
 * cells are hatched, seeded cells no one has taken are dotted, and cells of
 * players who left are dimmed. Nothing is carried by colour alone.
 */
export function Grid({ game, state, selected, onToggle, onOwnCell, onClaim, frame = null, playhead = null, names = {} }) {
  const g = state.grid;
  const [focus, setFocus] = useState(0);
  const [hover, setHover] = useState(null);
  if (!g?.shape) return <div className="board-empty">Loading the grid…</div>;
  const { steps, perBar, k } = g.shape;
  const beat = Math.max(1, k / g.shape.d); // columns per beat of the meter
  const mine = game.myCell;
  const participants = state.instance?.participants ?? {};
  const selectedCells = new Set(Object.entries(state.seats).filter(([a]) => selected.has(a)).map(([, s]) => s.cell));
  const seatedHere = !mine && game.isParticipant && g.status !== "closed";
  const claimMode = seatedHere && g.seating === "claim";
  const rowMode = seatedHere && g.seating === "row";
  const noteAt = (c) => (frame ? frame.get(c) ?? null : g.cells.get(c)?.note ?? null);
  const act = (c) => {
    const cell = g.cells.get(c);
    if (rowMode) { onClaim?.(rowOf(c)); return; }
    if (!cell?.owner) { if (claimMode) onClaim?.(c); return; }
    if (c === mine) onOwnCell?.();
    else onToggle?.(cell.owner);
  };
  const describe = (c) => {
    const cell = g.cells.get(c);
    const where = describeCell(c);
    const note = noteAt(c) ?? "nothing";
    if (!cell) return `${where}, void`;
    if (!cell.owner) return `${where}, seeded ${note}, free`;
    const who = cell.owner === state.me?.address ? "your cell" : `${names[cell.owner] ?? cell.owner}'s cell`;
    return `${who}, ${where}, ${note}${participants[cell.owner] ? "" : ", left the game"}`;
  };
  const onKey = (e) => {
    const n = 5 * steps;
    if (e.key === "ArrowRight") { setFocus((f) => (f + 5) % n); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { setFocus((f) => (f + n - 5) % n); e.preventDefault(); }
    else if (e.key === "ArrowDown") { setFocus((f) => f - rowOf(f) + ((rowOf(f) + 1) % 5)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setFocus((f) => f - rowOf(f) + ((rowOf(f) + 4) % 5)); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === " ") { act(focus); e.preventDefault(); }
  };
  const hv = hover !== null ? g.cells.get(hover) : null;
  return (
    <div className="grid-wrap">
      <div className="grid-scroll">
        <div className="grid" role="grid" aria-label={`grid of ${steps} columns`} tabIndex={0} onKeyDown={onKey}
             style={{ gridTemplateColumns: `4.5em repeat(${steps}, minmax(30px, 1fr))` }}>
          {ROWS.map((r, row) => (
            <div className="grid-row" role="row" key={r} style={{ display: "contents" }}>
              <div className="row-label" role="rowheader">{r}</div>
              {Array.from({ length: steps }, (_, t) => {
                const c = cellIndex(t, row);
                const cell = g.cells.get(c);
                const note = noteAt(c);
                const cls = ["gcell",
                  cell ? (cell.owner ? "" : "seeded") : "void",
                  t % perBar === 0 ? "bar" : t % beat === 0 ? "beat" : "",
                  c === mine ? "mine" : "", selectedCells.has(c) ? "sel" : "",
                  cell?.owner && !participants[cell.owner] ? "left" : "",
                  note ? "on" : "", playhead === t ? "now" : "", c === focus ? "focus" : "",
                  (claimMode && !cell?.owner) || rowMode ? "claimable" : ""].filter(Boolean).join(" ");
                return (
                  <div key={c} role="gridcell" aria-label={describe(c)} data-cell={c} className={cls}
                       onClick={() => act(c)} onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)}>
                    {note && <span className="note">{note}</span>}
                    {c === mine && <span className="dot" aria-hidden="true" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="board-hover" aria-live="polite">
        {hover !== null && hv?.owner ? (
          <><strong>{hv.owner === state.me?.address ? "You" : names[hv.owner] ?? hv.owner}</strong>{" · "}{describeCell(hover)}{" · "}{noteAt(hover) ?? "nothing"}
            {hv.n ? ` · ${hv.n} change${hv.n === 1 ? "" : "s"}, last at block ${hv.h}` : ""}</>
        ) : claimMode ? "Choose a free cell to sit at." : rowMode ? "Choose a row to play in; the step is drawn for you." : "\u00a0"}
      </div>
    </div>
  );
}
