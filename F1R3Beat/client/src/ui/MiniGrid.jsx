import { ROWS } from "../core/grid.js";

/** A header preview drawn small: five rows of cells, sounding cells filled. */
export function MiniGrid({ preview, size = 6 }) {
  const { shape, notes, grid } = preview;
  const steps = (shape.bars * shape.n * shape.k) / shape.d;
  const bytes = (grid.match(/../g) ?? []).map((x) => parseInt(x, 16));
  return (
    <svg className="mini" width={steps * size} height={5 * size} viewBox={`0 0 ${steps * size} ${5 * size}`} role="img"
         aria-label={`${bytes.filter((b) => b !== 255).length} notes over ${steps} columns`}>
      {bytes.map((b, c) => (b === 255 ? null : (
        <rect key={c} x={Math.floor(c / 5) * size} y={(c % 5) * size} width={size - 1} height={size - 1} fill={["#F3D630", "#3FA9F5", "#E5383B", "#F28C28", "#7FD17F"][c % 5]}>
          <title>{`${ROWS[c % 5]} ${notes[b]}`}</title>
        </rect>
      )))}
    </svg>
  );
}
