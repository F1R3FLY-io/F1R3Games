import { useState } from "react";
import { registerPasskey, passkeysAvailable } from "../../core/passkey";
import { Sigil } from "../components/Sigil";
import { useLoad, usePortal, usePortalCtx } from "../PortalContext";
import { downloadText, message } from "../util";

export function WalletPage() {
  const portal = usePortal();
  const { refresh } = usePortalCtx();
  const balance = useLoad((p) => p.balance(), []);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  if (!portal.signedOn) return <p>Sign on to see your wallet.</p>;
  const keys = portal.wallet.keys();
  const ask = (q: string) => window.prompt(q) ?? "";
  const run = (f: () => Promise<unknown>, ok: string) => async () => {
    try {
      setNote("Working…");
      await f();
      setNote(ok);
      refresh();
    } catch (e) {
      setNote(message(e));
    }
  };
  return (
    <section className="panel">
      <h1>Wallet</h1>
      <p className="addr">
        <Sigil address={portal.wallet.address} size={40} /> <code>{portal.wallet.address}</code>
      </p>
      <p>Balance: {balance.error ? <span className="muted">{balance.error}</span> : JSON.stringify(balance.data ?? "…")}</p>
      {portal.env.faucet && <button className="secondary small" onClick={run(() => portal.fund(), "Faucet requested.")}>Testnet faucet</button>}
      <h2>Send</h2>
      <div className="row">
        <input placeholder="F1R3Cap address" value={to} onChange={(e) => setTo(e.target.value)} />
        <input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        <button disabled={!portal.wallet.isAddress(to) || amount < 1} onClick={run(() => portal.transfer(to, amount), "Transfer sent.")}>Send</button>
      </div>
      <h2>Keys</h2>
      <ul className="plain">
        {keys.map((k) => (
          <li key={k.address}>
            <Sigil address={k.address} size={20} /> <code>{k.address}</code> {k.label} {k.active ? <strong>active</strong> : <button className="small secondary" onClick={run(() => portal.wallet.setActive(k.address), "Switched.")}>Use</button>}{" "}
            <button className="small secondary" onClick={() => { try { downloadText(`${k.address}.json`, portal.wallet.exportKeyFile(ask("Passphrase"), k.address)); } catch (e) { setNote(message(e)); } }}>Export</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="secondary" onClick={run(async () => { const r = await portal.wallet.createKey(`key ${keys.length + 1}`); downloadText(`${r.address}.json`, r.keyFile); }, "New key created; its file was downloaded.")}>New key</button>
        {passkeysAvailable() && (
          <button className="secondary" onClick={run(async () => { const pass = ask("Passphrase"); const r = await registerPasskey(portal.wallet.address); await portal.wallet.enrolPasskey(pass, r.credentialId, r.prfHex); }, "Passkey enrolled.")}>Unlock with a passkey too</button>
        )}
      </div>
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
