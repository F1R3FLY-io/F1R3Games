import { useId, useRef } from "react";

const initials = (name) => (name ?? "?").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

/** How a stripe reads to a screen reader, and on hover (§11: colour is also given by number and hex). */
export function describeStripe(v, { palette, names = {}, me = null, steps = null }) {
  const inker = v.by ?? (v.anon ? null : v.key);
  const who = v.mine || (me && inker === me) ? "your stripe" : inker ? `by ${names[inker] ?? inker.slice(0, 10)}` : v.anon ? "anonymous" : "";
  const colour = v.veiled ? "veiled" : v.colour === null ? (v.sealed ? "sealed" : "no colour") : `colour ${v.colour + 1}, ${palette[v.colour] ?? "?"}`;
  const left = v.lifted ? "lifted" : v.remaining === null || v.remaining === undefined ? "" : v.remaining === 0 ? "faded" : `${v.remaining}${steps ? ` of ${steps}` : ""} steps left`;
  return [colour, who, left].filter(Boolean).join(", ");
}

/**
 * A player's avatar with their flag behind it (design §3, Figure 1): one
 * horizontal stripe per inker, in location order, each as opaque as its
 * decay allows. Sealed stripes the viewer cannot open are hatched, veiled
 * ones are dashed, and the viewer's own stripe carries a notch at its left
 * end. Right-click, long-press or Enter on a stripe opens its history.
 */
export function Flag({ view = [], palette = [], name, size = 120, locked = false, badge = false, names = {}, me = null, steps = null,
                       labels = false, focusKey = null, onHistory = null, title = null }) {
  const id = useId().replace(/:/g, "");
  const press = useRef(null);
  const shown = view.filter((v) => !v.lifted && v.alpha > 0);
  const W = 160, H = 100, R = 30;
  const h = shown.length ? H / shown.length : H;
  const open = (v, e) => { if (onHistory) { e?.preventDefault?.(); onHistory(v, e); } };
  const down = (v, e) => { clearTimeout(press.current); press.current = setTimeout(() => open(v, e), 550); };
  const up = () => clearTimeout(press.current);
  const fillOf = (v) => (v.veiled ? `url(#veil-${id})` : v.colour === null ? `url(#hatch-${id})` : palette[v.colour] ?? "#555");
  return (
    <svg className="flag" width={(size * W) / H} height={size} viewBox={`0 0 ${W} ${H}`} role="group"
         aria-label={title ?? `${name ?? "player"}: ${shown.length} stripe${shown.length === 1 ? "" : "s"}${locked ? ", private" : ""}`}>
      <defs>
        <pattern id={`hatch-${id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#2a2a2a" /><line x1="0" y1="0" x2="0" y2="6" stroke="#6a6a6a" strokeWidth="2" />
        </pattern>
        <pattern id={`veil-${id}`} width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="#1a1a1a" /><circle cx="4" cy="4" r="1" fill="#555" />
        </pattern>
        <clipPath id={`clip-${id}`}><rect width={W} height={H} rx="8" /></clipPath>
      </defs>
      <g clipPath={`url(#clip-${id})`}>
        <rect width={W} height={H} fill="#141414" />
        {shown.map((v, i) => {
          const label = describeStripe(v, { palette, names, me, steps });
          return (
            <g key={v.key} className={`stripe${v.mine ? " mine" : ""}${focusKey === v.key ? " focus" : ""}`}>
              <rect x="0" y={i * h} width={W} height={h} fill={fillOf(v)} opacity={v.veiled ? 1 : v.alpha}
                    tabIndex={onHistory ? 0 : -1} role="img" aria-label={label}
                    onContextMenu={(e) => open(v, e)} onPointerDown={(e) => down(v, e)} onPointerUp={up} onPointerLeave={up}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === "ContextMenu") open(v, e); }}>
                <title>{label}</title>
              </rect>
              {v.mine && <path d={`M0 ${i * h} L${Math.min(10, h)} ${i * h + h / 2} L0 ${i * h + h} Z`} fill="#fff" pointerEvents="none" />}
              {labels && h >= 9 && (
                <text x={W - 4} y={i * h + h / 2 + 3} textAnchor="end" className="stripe-label" pointerEvents="none">
                  {v.mine ? "you" : v.by ? (names[v.by] ?? v.by.slice(0, 8)).split(" ")[0] : v.anon ? "anon" : ""}
                </text>
              )}
            </g>
          );
        })}
      </g>
      <circle cx={W / 2} cy={H / 2} r={R} fill="#0b0b0b" stroke="#000" strokeWidth="2" pointerEvents="none" />
      <text x={W / 2} y={H / 2 + 7} textAnchor="middle" className="initials" pointerEvents="none">{initials(name)}</text>
      {locked && (
        <g transform={`translate(${W / 2 + R - 10} ${H / 2 + R - 16})`} pointerEvents="none" aria-hidden="true">
          <rect x="0" y="6" width="14" height="11" rx="2" fill="#C5C5C5" /><path d="M3 6 V3 a4 4 0 0 1 8 0 V6" stroke="#C5C5C5" strokeWidth="2" fill="none" />
        </g>
      )}
      {badge && <circle cx={W / 2 + R - 4} cy={H / 2 - R + 6} r="7" fill="#3FA9F5" stroke="#000" strokeWidth="2"><title>a stripe on you changed</title></circle>}
    </svg>
  );
}

/** A frame from a play's preview or a replay: [colour or 255, remaining steps or null] per stripe. */
export function frameView(frame, steps) {
  return frame.map(([c, r], i) => ({ key: String(i), colour: c === 255 ? null : c, sealed: c === 255, lifted: false, veiled: false, mine: false,
    anon: false, by: null, remaining: r, alpha: r === null || r === undefined || !steps ? 1 : Math.max(0, r / steps) }));
}
