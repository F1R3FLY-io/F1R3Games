import { useEffect, useState } from "react";
import type { Contact } from "../../core/wallet";
import type { GameManifest, Sponsorship } from "../../core/portal";
import { usePortal } from "../PortalContext";
import { message } from "../util";

interface Issued {
  to: Contact | null;
  link: string;
}

function deliver(i: Issued, gameName: string) {
  const text = `Join me in ${gameName} on F1R3Games: ${i.link}`;
  const email = i.to?.channels.find((c) => c.kind === "email");
  if (email) return `mailto:${encodeURIComponent(email.handle)}?subject=${encodeURIComponent(`Play ${gameName} with me`)}&body=${encodeURIComponent(text)}`;
  return null;
}

/** The shared contact and invitation dialogue (design §11). */
export function InviteDialog({ instance, game, onClose }: { instance: string; game: GameManifest; onClose: () => void }) {
  const portal = usePortal();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openLink, setOpenLink] = useState(false);
  const [uses, setUses] = useState(5);
  const [sponsorships, setSponsorships] = useState<Sponsorship[]>([]);
  const [sponsorship, setSponsorship] = useState<string>("");
  const [issued, setIssued] = useState<Issued[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    portal.contacts().then((b) => setContacts(b.contacts)).catch(() => undefined);
    portal
      .sponsorships()
      .then((s) => setSponsorships(s.filter((x) => x.status === "active" && (x.terms.games.length === 0 || x.terms.games.includes(game.id)))))
      .catch(() => undefined);
  }, []);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const out: Issued[] = [];
      for (const c of contacts.filter((c) => picked.has(c.id))) {
        const r = await portal.invite(instance, { uses: 1, sponsorship: sponsorship || null });
        out.push({ to: c, link: r.link });
      }
      if (openLink) {
        const r = await portal.invite(instance, { uses, sponsorship: sponsorship || null });
        out.push({ to: null, link: r.link });
      }
      setIssued(out);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="invite-title">
      <div className="modal wide">
        <h2 id="invite-title">Invite players to {game.name}</h2>
        {issued.length === 0 ? (
          <>
            {contacts.length === 0 ? (
              <p className="muted">Your contact book is empty. Add contacts on the Contacts page, or make a shareable link.</p>
            ) : (
              <ul className="plain pick">
                {contacts.map((c) => (
                  <li key={c.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={picked.has(c.id)}
                        onChange={(e) => {
                          const n = new Set(picked);
                          e.target.checked ? n.add(c.id) : n.delete(c.id);
                          setPicked(n);
                        }}
                      />
                      {c.name} <span className="muted small">{c.channels.map((x) => `${x.kind}:${x.handle}`).join(", ")}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <label className="check">
              <input type="checkbox" checked={openLink} onChange={(e) => setOpenLink(e.target.checked)} /> Also make a shareable link for
              <input className="tiny" type="number" min={1} value={uses} onChange={(e) => setUses(Number(e.target.value))} /> people
            </label>
            {sponsorships.length > 0 && (
              <label>
                Newcomers receive a stipend from
                <select value={sponsorship} onChange={(e) => setSponsorship(e.target.value)}>
                  <option value="">no sponsorship</option>
                  {sponsorships.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.terms.name} — {s.terms.stipend} each
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="muted small">Each invitation is a one-use key recorded on the shard. Your contacts' details are never sent anywhere; you deliver the links yourself.</p>
            {error && <p className="error">{error}</p>}
            <div className="row">
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button disabled={busy || (picked.size === 0 && !openLink)} onClick={issue}>
                {busy ? "Issuing…" : "Issue invitations"}
              </button>
            </div>
          </>
        ) : (
          <>
            <ul className="plain">
              {issued.map((i) => (
                <li key={i.link} className="issued">
                  <strong>{i.to?.name ?? `Link for ${uses}`}</strong>
                  <input readOnly value={i.link} onFocus={(e) => e.target.select()} />
                  <div className="row">
                    <button className="small secondary" onClick={() => navigator.clipboard?.writeText(i.link)}>Copy</button>
                    {deliver(i, game.name) && (
                      <a className="button small secondary" href={deliver(i, game.name)!}>Email</a>
                    )}
                    {"share" in navigator && (
                      <button className="small secondary" onClick={() => navigator.share({ title: `Play ${game.name}`, url: i.link }).catch(() => undefined)}>
                        Share…
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="row">
              <button onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
