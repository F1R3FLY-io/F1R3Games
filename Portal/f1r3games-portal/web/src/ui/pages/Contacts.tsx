import { useEffect, useState } from "react";
import type { ContactBook } from "../../core/wallet";
import { usePortal } from "../PortalContext";
import { message } from "../util";

export function ContactsPage() {
  const portal = usePortal();
  const [book, setBook] = useState<ContactBook | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("email");
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (portal.signedOn) portal.contacts().then(setBook).catch((e) => setNote(message(e)));
  }, []);
  if (!portal.signedOn) return <p>Sign on to manage contacts.</p>;
  if (!book) return <p className="muted">Loading…</p>;

  const save = async (b: ContactBook) => {
    await portal.saveContacts(b);
    setBook(b);
  };
  const importFile = async (f: File) => {
    const text = await f.text();
    const r = portal.wallet.contactsImport(book, /BEGIN:VCARD/i.test(text) ? "vcard" : "csv", text);
    await save(r.book);
    setNote(r.rejected.length ? `Skipped ${r.rejected.length} lines that were not name,kind,handle.` : "Imported.");
  };

  return (
    <section className="panel">
      <h1>Contacts</h1>
      <p className="muted">
        Contacts are other people's details. They are encrypted on this device with a key derived from yours, and never appear on the shard except, if you choose,
        as an encrypted backup only your key can open.
      </p>
      <fieldset>
        <legend>Where they are kept</legend>
        <label className="radio">
          <input type="radio" checked={book.mode === "clientOnly"} onChange={() => save({ ...book, mode: "clientOnly" })} /> On this device only
        </label>
        <label className="radio">
          <input type="radio" checked={book.mode === "onChainBackup"} onChange={() => save({ ...book, mode: "onChainBackup" })} /> On this device, with an encrypted backup on the shard
        </label>
        {book.mode === "onChainBackup" && (
          <div className="row">
            <button className="small secondary" onClick={async () => { try { await portal.backupContacts(book); setNote("Backup sent."); } catch (e) { setNote(message(e)); } }}>Back up now</button>
            <button className="small secondary" onClick={async () => { try { setBook(await portal.restoreContacts()); setNote("Restored."); } catch (e) { setNote(message(e)); } }}>Restore from backup</button>
          </div>
        )}
      </fieldset>
      <h2>Add</h2>
      <div className="row">
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {["email", "discord", "slack", "mattermost", "telegram", "f1r3cap", "phone", "other"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <input placeholder="Handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
        <button
          disabled={!name || !handle}
          onClick={() => {
            const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
            save({ ...book, contacts: [...book.contacts, { id, name, channels: [{ kind, handle }], note: "", addedAt: Date.now() }] });
            setName("");
            setHandle("");
          }}
        >
          Add
        </button>
      </div>
      <label>
        Import a vCard (.vcf) or CSV (name,kind,handle) file
        <input type="file" accept=".vcf,.csv,.txt" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
      </label>
      <h2>{book.contacts.length} contacts</h2>
      <ul className="plain">
        {book.contacts.map((c) => (
          <li key={c.id}>
            <strong>{c.name}</strong> <span className="muted small">{c.channels.map((x) => `${x.kind}:${x.handle}`).join(", ")}</span>{" "}
            <button className="small secondary" onClick={() => save({ ...book, contacts: book.contacts.filter((x) => x.id !== c.id) })}>Remove</button>
          </li>
        ))}
      </ul>
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
