import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useLoad, usePortal } from "../PortalContext";
import { message } from "../util";

/** /i/<instance>#i=<invite key>: the invitee's landing page. */
export function Redeem() {
  const { id = "" } = useParams();
  const portal = usePortal();
  const nav = useNavigate();
  const link = location.href;
  const inst = useLoad((p) => p.instance(id), [id]);
  const game = useLoad(async (p) => (inst.data ? p.game(inst.data.game) : null), [inst.data?.game]);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = location.hash.includes("i=");

  if (!valid) return <p className="error">This invitation link is incomplete: the part after “#” is missing.</p>;
  const here = `${location.pathname}${location.hash}`;
  return (
    <section className="panel narrow">
      <h1>You are invited{game.data ? ` to ${game.data.name}` : ""}</h1>
      {inst.data && <p className="muted">{Object.keys(inst.data.participants).length} playing · {inst.data.status}</p>}
      {!portal.signedOn ? (
        <>
          <p>To play you need a key. It takes a minute and stays in this browser.</p>
          <Link className="button" to={`/signon?next=${encodeURIComponent(here)}`}>Create or unlock a key</Link>
        </>
      ) : (
        <button
          disabled={!!step}
          onClick={async () => {
            setError(null);
            try {
              if (portal.env.faucet) {
                setStep("Funding your first moves…");
                const f = await portal.fund().catch(() => null);
                if (f) await portal.waitFor(f.deployId);
              }
              setStep("Waiting for your approval…");
              const r = await portal.redeem(link);
              setStep("Joining…");
              await portal.waitFor(r.deployId);
              history.replaceState(null, "", location.pathname); // drop the key from the address bar
              nav(`/instances/${r.instanceId}`);
            } catch (e) {
              setError(message(e));
            } finally {
              setStep(null);
            }
          }}
        >
          {step ?? "Accept and join"}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
