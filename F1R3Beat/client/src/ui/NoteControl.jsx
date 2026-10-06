import { KIT, KIT_NAMES, RANGES, midiName, noteOk, ROWS } from "../core/grid.js";

/** The note control (design §8.1): the kit for the drum row; a keyboard strip for the others, scale notes enabled; and nothing. */
export function NoteControl({ row, current, scale, onPick, onClose, disabled }) {
  const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
  return (
    <div className="colour-control note-control" role="dialog" aria-label="Play your cell">
      <div className="cc-head">
        <span className="eyebrow">Play your cell · {ROWS[row]}</span>
        <button className="ghost" onClick={onClose} aria-label="Close">×</button>
      </div>
      {row === 0 ? (
        <div className="kit">
          {KIT.map(([k]) => (
            <button key={k} className={`ghost kit-piece${k === current ? " on" : ""}`} aria-pressed={k === current} disabled={disabled}
                    title={KIT_NAMES[k]} onClick={() => onPick(k)}>{k}<span className="small muted"> {KIT_NAMES[k]}</span></button>
          ))}
        </div>
      ) : (
        <div className="keys-strip" role="group" aria-label={`${ROWS[row]} pitches`}>
          {Array.from({ length: RANGES[row][1] - RANGES[row][0] + 1 }, (_, i) => RANGES[row][0] + i).map((m) => {
            const n = midiName(m);
            const ok = noteOk(row, n, scale ?? null);
            return (
              <button key={m} className={`key${isBlack(m) ? " black" : ""}${n === current ? " on" : ""}`} aria-label={n} aria-pressed={n === current}
                      disabled={disabled || !ok} title={n} onClick={() => onPick(n)}>{n.startsWith("C") && !n.includes("#") ? n : ""}</button>
            );
          })}
        </div>
      )}
      <div className="cc-free">
        <button className="ghost" aria-pressed={current === null} disabled={disabled} onClick={() => onPick(null)}>Nothing</button>
        <span className="small muted">{current ? `now: ${current}` : "now: nothing"}{scale ? ` · scale ${scale[1]} ${scale[0]}` : ""}</span>
      </div>
    </div>
  );
}
