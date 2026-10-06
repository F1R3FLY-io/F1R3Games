import { useState } from "react";
import { Async } from "../components/Async";
import { Sigil, short } from "../components/Sigil";
import { useLoad, usePortal, usePortalCtx } from "../PortalContext";
import { hexOfText } from "../../core/values";
import { message } from "../util";

/** Sponsorships: stakeholders fund stipends for players (design decision 5). */
export function Sponsors() {
  const portal = usePortal();
  const { refresh } = usePortalCtx();
  const list = useLoad((p) => p.sponsorships());
  const games = useLoad((p) => p.games());
  const [f, setF] = useState({ name: "", message: "", link: "", stipend: 100000, maxPerAddress: 1, expiresAt: 1_000_000, amount: 10_000_000 });
  const [chosen, setChosen] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.value });
  return (
    <>
      <h1>Sponsorships</h1>
      <p className="muted">Sponsors fund stipends that pay for newcomers' first moves. Funds are held in an escrow vault on the shard and paid out by the games environment.</p>
      <Async state={list} empty={<p className="muted">No sponsorships yet.</p>}>
        {(ss) => (
          <div className="grid">
            {ss.map((s) => (
              <div className="card" key={s.id}>
                <div className="card-body">
                  <div className="card-title">{s.terms.name}</div>
                  {s.terms.message && <p>{s.terms.message}</p>}
                  <p className="muted small">
                    <Sigil address={s.sponsor} size={16} /> {short(s.sponsor)} · {s.terms.stipend} per player · {(s.funded - s.paid).toLocaleString()} left · {s.status}
                  </p>
                  <p className="muted small">{s.terms.games.length ? `For ${s.terms.games.join(", ")}` : "For every game"} · until block {s.terms.expiresAt}</p>
                  {s.terms.link && <a href={s.terms.link} target="_blank" rel="noopener noreferrer">{s.terms.link}</a>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Async>
      {portal.signedOn && (
        <section className="panel narrow">
          <h2>Sponsor players</h2>
          <label>Name<input value={f.name} onChange={set("name")} /></label>
          <label>Message<input value={f.message} onChange={set("message")} /></label>
          <label>Link<input value={f.link} onChange={set("link")} /></label>
          <fieldset>
            <legend>Games (none = all)</legend>
            {(games.data ?? []).map((g) => (
              <label key={g.id} className="check">
                <input type="checkbox" checked={chosen.includes(g.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, g.id] : chosen.filter((x) => x !== g.id))} /> {g.name}
              </label>
            ))}
          </fieldset>
          <label>Stipend per player<input type="number" value={f.stipend} onChange={set("stipend")} /></label>
          <label>Claims per address<input type="number" value={f.maxPerAddress} onChange={set("maxPerAddress")} /></label>
          <label>Expires at block<input type="number" value={f.expiresAt} onChange={set("expiresAt")} /></label>
          <label>Fund with<input type="number" value={f.amount} onChange={set("amount")} /></label>
          <button
            disabled={!f.name || f.amount < f.stipend}
            onClick={async () => {
              try {
                setNote("Waiting for approval…");
                const r = await portal.sponsor({ name: f.name, message: f.message, link: f.link, games: chosen, stipend: f.stipend, maxPerAddress: f.maxPerAddress, expiresAt: f.expiresAt, creativeHex: hexOfText("") }, f.amount);
                setNote("Waiting for the shard…");
                await portal.waitFor(r.deployId);
                setNote(`Sponsorship ${r.id} created.`);
                refresh();
              } catch (e) {
                setNote(message(e));
              }
            }}
          >
            Create sponsorship
          </button>
          {note && <p className="muted">{note}</p>}
        </section>
      )}
    </>
  );
}
