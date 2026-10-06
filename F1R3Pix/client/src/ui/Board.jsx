import { useMemo, useRef, useState } from "react";
import { board as cellsOf, corners, centre, key } from "../core/hex.js";
import { inkOn } from "../core/colour.js";

const SIZE = 20;
const pts = (q, r, s = 1) => corners(q, r, SIZE, s).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

/**
 * The board (design §9.1). Your cell: black outline and a centre dot. Selected
 * players: dark-sky outline that pulses. Void cells: dashed outlines. Players
 * who left: dimmed. Nothing is carried by colour alone.
 */
export function Board({ game, state, selected, onToggle, onOwnCell, onClaim, frame = null, names = {} }) {
  const b = state.board;
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(0);
  const svg = useRef(null);
  const all = useMemo(() => (b ? cellsOf(b.radius) : []), [b?.radius]);
  if (!b) return <div className="board-empty">Loading the board…</div>;
  const mine = game.myCell;
  const participants = state.instance?.participants ?? {};
  const selectedCells = new Set(Object.entries(state.seats).filter(([a]) => selected.has(a)).map(([, s]) => key(...s.cell)));
  const extent = SIZE * (Math.sqrt(3) * (b.radius + 0.5)) + 6;
  const claimMode = b.seating === "claim" && !mine && game.isParticipant && state.board.status !== "closed";

  const act = (q, r) => {
    const cell = b.cells.get(key(q, r));
    if (!cell) { if (claimMode) onClaim?.([q, r]); return; }
    if (mine && mine[0] === q && mine[1] === r) onOwnCell?.();
    else onToggle?.(cell.owner);
  };
  const onKey = (e) => {
    const n = all.length;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { setFocus((f) => (f + 1) % n); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { setFocus((f) => (f + n - 1) % n); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === " ") { act(...all[focus]); e.preventDefault(); }
  };
  const describe = (q, r) => {
    const c = b.cells.get(key(q, r));
    if (!c) return `void cell ${q},${r}`;
    const who = c.owner === state.me?.address ? "your cell" : `${names[c.owner] ?? c.owner}'s cell`;
    const colour = (frame ? frame.get(key(q, r)) : c.colour) ?? "unpainted";
    return `${who}, ${colour}${participants[c.owner] ? "" : ", left the game"}`;
  };
  const hv = hover && b.cells.get(key(...hover));

  return (
    <div className="board-wrap">
      <svg
        ref={svg}
        className="board"
        viewBox={`${-extent} ${-extent} ${2 * extent} ${2 * extent}`}
        role="grid"
        aria-label={`board of radius ${b.radius}`}
        tabIndex={0}
        onKeyDown={onKey}
      >
        {all.map(([q, r], i) => {
          const c = b.cells.get(key(q, r));
          const k = key(q, r);
          const colour = frame ? frame.get(k) : c?.colour;
          const isMine = mine && mine[0] === q && mine[1] === r;
          const left = c && !participants[c.owner];
          return (
            <g key={k} role="gridcell" aria-label={describe(q, r)} data-cell={k}
               onClick={() => act(q, r)} onMouseEnter={() => setHover([q, r])} onMouseLeave={() => setHover(null)}
               className={`cell${c ? "" : " void"}${claimMode && !c ? " claimable" : ""}${left ? " left" : ""}`}>
              {c ? (
                <polygon points={pts(q, r, 0.95)} fill={colour ?? "var(--unpainted)"} className={colour ? "" : "unpainted"} />
              ) : (
                <polygon points={pts(q, r, 0.9)} className="void-outline" />
              )}
              {selectedCells.has(k) && <polygon points={pts(q, r, 1.02)} className="sel-outline" />}
              {isMine && (
                <>
                  <polygon points={pts(q, r, 1.02)} className="mine-outline" />
                  <circle cx={centre(q, r, SIZE)[0]} cy={centre(q, r, SIZE)[1]} r={2.6} fill={inkOn(colour)} stroke={colour ? "none" : "#000"} />
                </>
              )}
              {i === focus && <polygon points={pts(q, r, 0.7)} className="focus-ring" />}
            </g>
          );
        })}
      </svg>
      <div className="board-hover" aria-live="polite">
        {hv ? (
          <>
            <strong>{hv.owner === state.me?.address ? "You" : names[hv.owner] ?? hv.owner}</strong>
            {" · "}{(frame ? frame.get(key(...hover)) : hv.colour) ?? "unpainted"}
            {hv.n ? ` · ${hv.n} change${hv.n === 1 ? "" : "s"}, last at block ${hv.h}` : ""}
          </>
        ) : claimMode ? "Choose a free cell to sit at." : "\u00a0"}
      </div>
    </div>
  );
}
