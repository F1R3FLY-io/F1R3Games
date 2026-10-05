import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { evaluatePasskey, passkeysAvailable, registerPasskey } from "../../core/passkey";
import { usePortal, usePortalCtx } from "../PortalContext";
import { downloadText, message, nextParam } from "../util";

type Mode = "unlock" | "create" | "import";

export function SignOn() {
  const portal = usePortal();
  const { refresh } = usePortalCtx();
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("create");
  const [hasPasskey, setHasPasskey] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ address: string; keyFile: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    portal.wallet.exists().then((e) => e && setMode("unlock"));
    portal.wallet.hasPasskey().then(setHasPasskey);
  }, []);

  const done = () => {
    refresh();
    nav(nextParam());
  };

  const run = (f: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <section className="panel narrow">
        <h1>Your key</h1>
        <p>
          Address <code>{created.address}</code>
        </p>
        <p>
          This file <em>is</em> your account. Nobody can recover it for you. It also opens in F1R3Sky and F1R3Gaze.
        </p>
        <button onClick={() => (downloadText(`${created.address}.json`, created.keyFile), setSaved(true))}>Download key file</button>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved my key file, or I accept that losing this device loses the key.
        </label>
        {passkeysAvailable() && (
          <button
            className="secondary"
            disabled={busy}
            onClick={run(async () => {
              const { credentialId, prfHex } = await registerPasskey(created.address);
              await portal.wallet.enrolPasskey(pass, credentialId, prfHex);
            })}
          >
            Also unlock with a passkey
          </button>
        )}
        <label>
          Display name (optional, public)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" />
        </label>
        {error && <p className="error">{error}</p>}
        <button
          disabled={!saved || busy}
          onClick={run(async () => {
            if (portal.env.faucet) await portal.fund().catch(() => undefined);
            if (name.trim()) await portal.saveProfile(name.trim());
            done();
          })}
        >
          Continue
        </button>
      </section>
    );
  }

  return (
    <section className="panel narrow">
      <div className="tabs">
        <button className={mode === "unlock" ? "tab on" : "tab"} onClick={() => setMode("unlock")}>Unlock</button>
        <button className={mode === "create" ? "tab on" : "tab"} onClick={() => setMode("create")}>Create a key</button>
        <button className={mode === "import" ? "tab on" : "tab"} onClick={() => setMode("import")}>Import a key file</button>
      </div>
      {mode === "unlock" && (
        <>
          <label>
            Passphrase
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
          </label>
          <button disabled={busy} onClick={run(async () => (portal.wallet.unlock(pass), done()))}>Unlock</button>
          {hasPasskey && (
            <button className="secondary" disabled={busy} onClick={run(async () => (await portal.wallet.unlockWithPasskey(evaluatePasskey), done()))}>
              Unlock with passkey
            </button>
          )}
        </>
      )}
      {mode === "create" && (
        <>
          <p className="muted">A new secp256k1 key is made in this browser. The passphrase encrypts it here; it is never sent anywhere.</p>
          <label>
            Passphrase
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </label>
          <label>
            Again
            <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </label>
          <button
            disabled={busy || pass.length < 8 || pass !== pass2}
            onClick={run(async () => setCreated(await portal.createIdentity(pass)))}
          >
            {busy ? "Creating…" : "Create key"}
          </button>
          {pass.length > 0 && pass.length < 8 && <p className="muted small">At least 8 characters.</p>}
        </>
      )}
      {mode === "import" && (
        <>
          <label>
            Key file (F1R3Sky, F1R3Gaze or F1R3Games)
            <input type="file" accept=".json,.txt" onChange={async (e) => setFile((await e.target.files?.[0]?.text()) ?? "")} />
          </label>
          <label>
            New passphrase for this device
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </label>
          <button disabled={busy || !file || pass.length < 8} onClick={run(async () => (await portal.importIdentity(pass, file), done()))}>
            Import
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
