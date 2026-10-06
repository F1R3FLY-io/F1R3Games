import { usePortalCtx } from "../PortalContext";

/** The consent prompt: every signature outside an allowance passes here. */
export function ConsentDialog() {
  const { consentRequest: r, answerConsent } = usePortalCtx();
  if (!r) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="modal">
        <h2 id="consent-title">Approve this signature?</h2>
        <p className="muted">{r.origin === "portal" ? "Requested by the portal" : `Requested by the game ${r.origin}`}</p>
        <pre className="summary">{r.summary}</pre>
        <dl className="kv">
          <dt>Estimated cost</dt>
          <dd>{r.estimatedCost ?? "unknown"} phlo</dd>
          <dt>At most</dt>
          <dd>{r.maxFee.toLocaleString()} (phlo price × limit)</dd>
        </dl>
        <div className="row">
          <button className="secondary" onClick={() => answerConsent(false)}>
            Refuse
          </button>
          <button onClick={() => answerConsent(true)}>Sign and send</button>
        </div>
      </div>
    </div>
  );
}
