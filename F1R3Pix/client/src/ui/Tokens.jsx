import { useState } from "react";
import { planPayment } from "../core/amounts.js";

/** Left column: balance, send (each / split, D7), and the instance's recent payments. */
export function Tokens({ game, state, selected, names, me }) {
  const [mode, setMode] = useState("each");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const recipients = [...selected];
  const n = Number(amount);
  const plan = amount === "" ? null : planPayment({ mode, amount: Number.isInteger(n) ? n : NaN, recipients });
  const send = async () => {
    setBusy(true); setMsg(null);
    try { await game.pay({ mode, amount: n, recipients, memo: memo.trim() || null }); setAmount(""); setMemo(""); setMsg("Sent. It appears below once a block includes it."); }
    catch (e) { setMsg(e.code === "declined" ? "Not approved." : e.message ?? String(e)); }
    finally { setBusy(false); }
  };
  const name = (a) => (a === me ? "you" : names[a] ?? a.slice(0, 8));
  return (
    <section className="col col-left" aria-label="Tokens">
      <div className="panel">
        <div className="eyebrow">Balance</div>
        <div className="balance">{state.balance === null ? "—" : state.balance.toLocaleString()}<span className="unit"> F1R3Cap</span></div>
      </div>
      <div className="panel">
        <div className="eyebrow">Send</div>
        <p className="small muted">{recipients.length ? `to ${recipients.length} selected player${recipients.length > 1 ? "s" : ""}` : "Select players on the right or on the board."}</p>
        <div className="toggle" role="radiogroup" aria-label="amount means">
          {["each", "split"].map((m) => <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{m}</button>)}
        </div>
        <input aria-label="amount" inputMode="numeric" placeholder="amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} />
        <input aria-label="memo" placeholder="memo (public, optional)" maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} />
        {plan && (plan.error ? (
          <p className="small warn">{plan.error}{plan.suggestions?.length ? ` — try ${plan.suggestions.join(" or ")}` : ""}</p>
        ) : <p className="small">{plan.line}</p>)}
        <button disabled={busy || !plan || !!plan.error || state.board?.status === "closed"} onClick={send}>Send</button>
        {msg && <p className="small muted" role="status">{msg}</p>}
      </div>
      <div className="panel grow">
        <div className="eyebrow">Recent payments</div>
        <ul className="payments">
          {state.payments.length === 0 && <li className="muted small">None yet in this game.</li>}
          {state.payments.slice(0, 30).map((p) => (
            <li key={`${p.from}:${p.seq}`} className={p.ok ? "" : "failed"} title={p.memo ?? ""}>
              {p.from === me ? <>{p.amount} → {name(p.to)}</> : p.to === me ? <>{name(p.from)} → {p.amount}</> : <>{name(p.from)} → {name(p.to)} {p.amount}</>}
              {!p.ok && <span className="small"> (failed: {p.reason})</span>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
