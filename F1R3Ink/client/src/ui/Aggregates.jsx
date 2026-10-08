import { useEffect, useState } from "react";

/** Load the round's history once per new block, for the aggregate views. */
export function useEvents(game, state) {
  const [events, setEvents] = useState(state.events);
  const [err, setErr] = useState(null);
  useEffect(() => { let live = true; game.history().then((e) => live && setEvents(e)).catch((e) => live && setErr(e.message ?? String(e))); return () => { live = false; }; }, [state.height]);
  return { events, err };
}

function Sparkline({ values, label, height = 36 }) {
  if (!values.length) return null;
  const W = 300, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * W},${height - 2 - (v / max) * (height - 4)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${values.join(", ")}`}>
      <polyline points={pts} fill="none" stroke="#00528C" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export const unitName = (decay) => duration(decay?.unit ?? 3_600_000, true);
/** A span as people say it: "10 minutes", "a day", "6 hours". */
export function duration(ms, unit = false) {
  const [n, w] = ms % 86_400_000 === 0 ? [ms / 86_400_000, "day"] : ms % 3_600_000 === 0 ? [ms / 3_600_000, "hour"] : [Math.max(1, Math.round(ms / 60_000)), "minute"];
  return n === 1 ? (unit ? w : `a ${w}`.replace("a hour", "an hour")) : `${n} ${w}s`;
}

/** Spectrum (D13): the community now, from the flags the viewer may see; volume beneath, from every ink. */
export function Spectrum({ game, state }) {
  const { events } = useEvents(game, state);
  const s = game.spectrum();
  const palette = state.round?.palette ?? [];
  const vol = events ? game.volume(events) : [];
  return (
    <div className="panel aggregate" aria-label="Spectrum">
      <div className="cc-head"><span className="eyebrow">Spectrum</span><span className="small muted">{s.from} of {s.of} flags</span></div>
      <div className="band" role="img" aria-label={s.total ? palette.map((h, i) => (s.shares[i] ? `colour ${i + 1} ${Math.round(s.shares[i] * 100)}%` : null)).filter(Boolean).join(", ") : "no colour yet"}>
        {s.total === 0 && <span className="small muted band-empty">No visible colour yet.</span>}
        {palette.map((hex, i) => s.shares[i] > 0 && (
          <span key={hex} style={{ flexGrow: s.shares[i], background: hex }} title={`${i + 1} · ${hex} · ${Math.round(s.shares[i] * 100)}%`} />
        ))}
      </div>
      <p className="small muted">Every public flag{state.round?.reciprocity ? " (if yours is public too)" : ""}, your own flag and your own stripes, weighted by how fresh each stripe is.{s.of > s.from ? ` ${s.of - s.from} private ${s.of - s.from === 1 ? "flag is" : "flags are"} not in the picture.` : ""}</p>
      <Sparkline values={vol} label="inks per unit" />
      <p className="small muted">Volume: inks per {unitName(state.round?.decay)}, whole round{events ? ` · ${events.filter((e) => e.type === "ink").length} inks` : ""}.</p>
    </div>
  );
}

/** Trend (D13): one flag over time as a stream of colour shares, and the volume of inks it received. */
export function Trend({ game, state, target }) {
  const { events } = useEvents(game, state);
  const palette = state.round?.palette ?? [];
  const name = target === state.me?.address ? "you" : state.names[target] ?? target?.slice(0, 10);
  if (!events) return <div className="panel aggregate">Loading the record…</div>;
  const series = game.trend(target, events);
  const received = (() => {
    if (!events.length) return [];
    const mine = events.filter((e) => e.type === "ink" && e.target === target && !e.ink.lifted);
    const bucket = state.round?.decay?.unit ?? 3_600_000;
    const start = events[0].t, end = Math.max(game.now, events[events.length - 1].t + 1);
    const n = Math.max(1, Math.ceil((end - start) / bucket));
    const out = Array(n).fill(0);
    for (const e of mine) out[Math.min(n - 1, Math.floor((e.t - start) / bucket))]++;
    return out;
  })();
  const W = 300, H = 90;
  const layers = [];
  if (series) {
    const k = series.length;
    const x = (i) => (k === 1 ? W : (i / (k - 1)) * W);
    const order = [...palette.keys(), "unknown"];
    let base = series.map(() => 0);
    for (const c of order) {
      const share = series.map((p) => { const tot = p.weights.reduce((a, b) => a + b, 0) + p.unknown; return tot ? (c === "unknown" ? p.unknown : p.weights[c]) / tot : 0; });
      if (share.every((v) => v === 0)) continue;
      const top = base.map((b, i) => b + share[i]);
      const d = `M${series.map((_, i) => `${x(i)},${H - top[i] * H}`).join(" L")} L${series.map((_, i) => `${x(k - 1 - i)},${H - base[k - 1 - i] * H}`).join(" L")} Z`;
      layers.push(<path key={c} d={d} fill={c === "unknown" ? "#3a3a3a" : palette[c]}><title>{c === "unknown" ? "sealed, unknown to you" : `${c + 1} · ${palette[c]}`}</title></path>);
      base = top;
    }
  }
  return (
    <div className="panel aggregate" aria-label="Trend">
      <div className="cc-head"><span className="eyebrow">Trend</span><span className="small muted">{name}</span></div>
      {series ? (
        <svg className="stream" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`colour shares on ${name}'s flag over the round`}>
          <rect width={W} height={H} fill="#141414" />{layers}
        </svg>
      ) : <p className="small muted">{name}'s flag is private: you see only how many inks it received.</p>}
      <Sparkline values={received} label={`inks ${name} received`} />
      <p className="small muted">Inks {name === "you" ? "you" : name} received per {unitName(state.round?.decay)}.</p>
    </div>
  );
}
