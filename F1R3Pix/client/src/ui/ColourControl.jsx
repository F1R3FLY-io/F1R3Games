import { useState } from "react";
import { SWATCHES, normalise, inkOn } from "../core/colour.js";

/** Palette, free picker, recent colours and the hex value (D4). */
export function ColourControl({ current, palette, recent, onPick, onClose, disabled }) {
  const [hex, setHex] = useState(current ?? "#F3D630");
  const choices = palette ?? SWATCHES;
  const pick = (c) => { const n = normalise(c); if (n) { setHex(n); onPick(n); } };
  return (
    <div className="colour-control" role="dialog" aria-label="Paint your cell">
      <div className="cc-head">
        <span className="eyebrow">Paint your cell</span>
        <button className="ghost" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="swatches">
        {choices.map((c) => (
          <button key={c} className={`swatch${c === current ? " on" : ""}`} style={{ background: c, color: inkOn(c) }}
                  title={c} aria-label={c} disabled={disabled} onClick={() => pick(c)}>{c === current ? "●" : ""}</button>
        ))}
      </div>
      {!palette && (
        <div className="cc-free">
          <input type="color" aria-label="any colour" value={hex} disabled={disabled} onChange={(e) => setHex(e.target.value.toUpperCase())} />
          <input className="hex" aria-label="hex value" value={hex} disabled={disabled} onChange={(e) => setHex(e.target.value)} />
          <button disabled={disabled || !normalise(hex)} onClick={() => pick(hex)}>Paint</button>
        </div>
      )}
      {recent.length > 0 && (
        <div className="recent">
          <span className="muted small">Recent</span>
          {recent.map((c) => <button key={c} className="swatch small" style={{ background: c }} title={c} aria-label={`recent ${c}`} disabled={disabled} onClick={() => pick(c)} />)}
        </div>
      )}
      {palette && <p className="muted small">This game is limited to its host's palette.</p>}
    </div>
  );
}
