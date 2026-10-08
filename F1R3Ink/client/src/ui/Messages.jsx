import { useEffect, useRef, useState } from "react";

/** The message thread with the selected players (D11, as F1R3Pix D6): sealed to the recipients and the sender. */
export function Messages({ game, state, selected, names }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const thread = useRef(null);
  const me = state.me?.address;
  const shown = state.messages.filter((m) => selected.size === 0 || selected.has(m.from) || m.to?.some((a) => selected.has(a)));
  useEffect(() => { thread.current?.scrollTo?.(0, thread.current.scrollHeight); }, [shown.length]);
  const send = async () => {
    setBusy(true); setErr(null);
    try { await game.say(text, [...selected]); setText(""); } catch (e) { setErr(e.message ?? String(e)); } finally { setBusy(false); }
  };
  const name = (a) => (a === me ? "you" : names[a] ?? a.slice(0, 8));
  const closed = game.status === "closed";
  return (
    <div className="panel thread-panel" aria-label="Messages">
      <div className="eyebrow">Messages</div>
      <ol className="thread" ref={thread}>
        {shown.map((m, i) => (
          <li key={m.local ? `l${i}` : `${m.from}:${m.seq}`} className={`msg${m.from === me ? " sent" : ""}${m.local ? " pending" : ""}`}>
            <div className="small muted">{name(m.from)} → {m.to?.map(name).join(", ")}{m.local ? " · sending" : ""}</div>
            <div>{m.text ?? <em className="muted">{m.error ?? "opening…"}</em>}</div>
          </li>
        ))}
        {shown.length === 0 && <li className="muted small">Ask someone why they chose a colour. Messages are sealed to their recipients; who wrote to whom, and when, is public.</li>}
      </ol>
      <div className="compose">
        <textarea aria-label="message" rows={2} placeholder={selected.size ? `Message ${selected.size} selected` : "Select players first"} value={text}
                  disabled={!selected.size || busy || closed} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (text.trim()) send(); } }} />
        <button disabled={!selected.size || !text.trim() || busy || closed} onClick={send}>Send</button>
      </div>
      {err && <p className="small warn" role="alert">{err}</p>}
    </div>
  );
}
