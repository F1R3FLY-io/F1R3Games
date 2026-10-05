import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Async } from "../components/Async";
import { InviteDialog } from "../components/InviteDialog";
import { Sigil, short } from "../components/Sigil";
import { useLoad, usePortal, usePortalCtx } from "../PortalContext";
import { message } from "../util";

export function InstancePage() {
  const { id = "" } = useParams();
  const portal = usePortal();
  const { refresh } = usePortalCtx();
  const inst = useLoad((p) => p.instance(id), [id]);
  const game = useLoad(async (p) => (inst.data ? p.game(inst.data.game) : null), [inst.data?.game]);
  const sponsors = useLoad(async (p) => (inst.data ? (await p.sponsorships()).filter((s) => s.status === "active" && (s.terms.games.length === 0 || s.terms.games.includes(inst.data!.game))) : []), [inst.data?.game]);
  const [inviting, setInviting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const act = (f: () => Promise<{ deployId: string }>, done: string) => async () => {
    try {
      setNote("Waiting for approval…");
      const r = await f();
      setNote("Waiting for the shard…");
      await portal.waitFor(r.deployId);
      setNote(done);
      refresh();
    } catch (e) {
      setNote(message(e));
    }
  };

  return (
    <Async state={inst} empty={<p className="muted">This instance is not on the shard yet (or does not exist). If you just launched it, give the block a moment.</p>}>
      {(i) => {
        const me = portal.signedOn ? portal.wallet.address : null;
        const isHost = me === i.host;
        const isIn = !!me && me in i.participants;
        const g = game.data;
        return (
          <section className="panel">
            <h1>{g?.name ?? i.game}</h1>
            <p className="muted">
              Instance {i.id} · {i.visibility} · {i.status}
            </p>
            <h2>Players</h2>
            <ul className="plain players">
              {Object.entries(i.participants).map(([a, p]) => (
                <li key={a}>
                  <Sigil address={a} size={24} /> {short(a)} <span className="muted small">{p.role}</span>
                </li>
              ))}
            </ul>
            <div className="row">
              {isIn && g && <Link className="button" to={`/instances/${i.id}/play`}>Play</Link>}
              {!isIn && me && i.visibility !== "private" && i.status !== "closed" && <button onClick={act(() => portal.join(i.id), "You have joined.")}>Join</button>}
              {!me && <Link className="button" to={`/signon?next=/instances/${i.id}`}>Sign on to join</Link>}
              {isIn && g && g.contactsDialogue !== false && <button className="secondary" onClick={() => setInviting(true)}>Invite</button>}
              {isHost && i.status === "lobby" && <button className="secondary" onClick={act(() => portal.setStatus(i.id, "active"), "Started.")}>Start</button>}
              {isHost && i.status !== "closed" && <button className="secondary" onClick={act(() => portal.setStatus(i.id, "closed"), "Closed.")}>Close</button>}
            </div>
            {isIn && (sponsors.data?.length ?? 0) > 0 && (
              <>
                <h2>Sponsored</h2>
                <ul className="plain">
                  {sponsors.data!.map((s) => (
                    <li key={s.id}>
                      <strong>{s.terms.name}</strong> {s.terms.message && <span className="muted">— {s.terms.message}</span>}{" "}
                      <button className="small secondary" onClick={act(() => portal.claim(s.id, i.id), `Claimed ${s.terms.stipend}.`)}>
                        Claim {s.terms.stipend}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {note && <p className="muted">{note}</p>}
            {inviting && g && <InviteDialog instance={i.id} game={g} onClose={() => setInviting(false)} />}
          </section>
        );
      }}
    </Async>
  );
}
