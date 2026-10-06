import { useEffect, useRef, useState } from "react";
import { inkOn } from "../core/colour.js";
import { key } from "../core/hex.js";

function Avatar({ name, colour, size = 40 }) {
  const initials = (name ?? "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, boxShadow: `0 0 0 3px ${colour ?? "#3F3F3F"}` }} aria-hidden="true">{initials}</span>
  );
}

/** Right column: you, the vertical wheel of players (D8), invite, and the message thread. */
export function Players({ game, state, selected, onToggle, onClear, names }) {
  const [order, setOrder] = useState("near");
  const [focus, setFocus] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const thread = useRef(null);
  const list = game.wheel(order);
  const colourOf = (a) => { const s = state.seats[a]; return s ? state.board?.cells.get(key(...s.cell))?.colour ?? null : null; };
  const me = state.me?.address;
  const myColour = me ? colourOf(me) : null;
  const shown = state.messages.filter((m) => selected.size === 0 || selected.has(m.from) || m.to?.some((a) => selected.has(a)));
  useEffect(() => { thread.current?.scrollTo?.(0, thread.current.scrollHeight); }, [shown.length]);
  const onWheel = (e) => { if (!list.length) return; setFocus((f) => Math.max(0, Math.min(list.length - 1, f + Math.sign(e.deltaY)))); };
  const send = async () => {
    setBusy(true); setErr(null);
    try { await game.say(text, [...selected]); setText(""); } catch (e) { setErr(e.message ?? String(e)); } finally { setBusy(false); }
  };
  const name = (a) => (a === me ? "you" : names[a] ?? a.slice(0, 8));
  return (
    <section className="col col-right" aria-label="Players">
      <div className="panel you">
        <Avatar name={names[me] ?? "You"} colour={myColour} size={48} />
        <div>
          <div className="you-name">{names[me] ?? "You"}</div>
          <div className="small muted">{game.myCell ? `cell ${game.myCell.join(", ")} · ${myColour ?? "unpainted"}` : game.isParticipant ? "not seated yet" : "watching"}</div>
        </div>
      </div>
      <div className="panel wheel-panel">
        <div className="wheel-head">
          <span className="eyebrow">Players</span>
          <select aria-label="order" value={order} onChange={(e) => setOrder(e.target.value)}>
            <option value="near">nearest</option><option value="name">name</option><option value="recent">recent</option>
          </select>
          <button className="ghost small" onClick={() => game.bridge.invite().catch(() => {})}>Invite</button>
        </div>
        <ul className="wheel" onWheel={onWheel} aria-label="players, select any number">
          {list.map((a, i) => {
            const d = Math.abs(i - focus);
            const scale = Math.max(0.55, 1 - d * 0.12);
            const on = selected.has(a);
            return (
              <li key={a} style={{ transform: `scale(${scale})`, opacity: Math.max(0.45, 1 - d * 0.1) }}>
                <button className={`wheel-item${on ? " on" : ""}`} aria-pressed={on} onClick={() => { setFocus(i); onToggle(a); }}>
                  <Avatar name={names[a]} colour={colourOf(a)} size={36} />
                  <span className="wheel-name">{names[a] ?? a.slice(0, 10)}</span>
                  {!state.instance?.participants?.[a] && <span className="small muted">left</span>}
                  {!state.seats[a] && <span className="small muted">not seated</span>}
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="muted small">No one else yet. Invite someone.</li>}
        </ul>
        {selected.size > 0 && <button className="ghost small" onClick={onClear}>Clear selection ({selected.size})</button>}
      </div>
      <div className="panel thread-panel">
        <div className="eyebrow">Messages</div>
        <ol className="thread" ref={thread}>
          {shown.map((m, i) => (
            <li key={m.local ? `l${i}` : `${m.from}:${m.seq}`} className={`msg${m.from === me ? " sent" : ""}${m.local ? " pending" : ""}`}>
              <div className="small muted">{name(m.from)} → {m.to?.map(name).join(", ")}{m.local ? " · sending" : ""}</div>
              <div style={m.from !== me ? { borderColor: colourOf(m.from) ?? undefined } : undefined}>{m.text ?? <em className="muted">{m.error ?? "opening…"}</em>}</div>
            </li>
          ))}
          {shown.length === 0 && <li className="muted small">Messages are sealed to their recipients. Who wrote to whom, and when, is public.</li>}
        </ol>
        <div className="compose">
          <textarea aria-label="message" rows={2} placeholder={selected.size ? `Message ${selected.size} selected` : "Select players first"} value={text}
                    disabled={!selected.size || busy || state.board?.status === "closed"} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (text.trim()) send(); } }} />
          <button disabled={!selected.size || !text.trim() || busy} onClick={send}>Send</button>
        </div>
        {err && <p className="small warn" role="alert">{err}</p>}
      </div>
    </section>
  );
}

export { Avatar };
