import { useState, useEffect, useCallback, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
// F1R3Games — Unified Shard-Native Auth for the F1R3 Suite
//
// Identity model:
//   - A keypair (private + public) is generated client-side
//   - The public key IS the shard address (player identity)
//   - The private key IS the sole credential (no passwords, no email)
//   - Account profile stored on shared shard at `f1r3-account:{address}`
//   - Private key stored locally (personal shard) for session persistence
//   - To log in on a new device: paste your private key
//
// Shard key schema:
//   f1r3-account:{address}  (shared) → { address, name, tags, avatar, createdAt, lastSeen }
//   f1r3-auth-privkey        (local) → hex string of private key
//   f1r3-auth-address         (local) → hex string of public address
// ══════════════════════════════════════════════════════════════════

// ── Shard helpers ────────────────────────────────────────────────
const sh = {
  async get(k, shared = true) {
    try { const r = await window.storage.get(k, shared); return r?.value ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async set(k, v, shared = true) {
    try { await window.storage.set(k, JSON.stringify(v), shared); return true; }
    catch { return false; }
  },
  async del(k, shared = true) {
    try { await window.storage.delete(k, shared); return true; }
    catch { return false; }
  },
  async list(prefix) {
    try { const r = await window.storage.list(prefix, true); return r?.keys || []; }
    catch { return []; }
  },
};

const ACCOUNT_PREFIX = "f1r3-account:";
const LOCAL_PRIVKEY = "f1r3-auth-privkey";
const LOCAL_ADDRESS = "f1r3-auth-address";

// ── Crypto: keypair generation via Web Crypto + hashing ──────────
// We use ECDSA P-256 for real asymmetric crypto, then derive a
// compact hex "address" from the public key hash.
async function generateKeypair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, // extractable
    ["sign", "verify"]
  );
  const privRaw = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const pubRaw = await crypto.subtle.exportKey("spki", keyPair.publicKey);

  const privHex = bufToHex(privRaw);
  const pubHash = await hashBuffer(pubRaw);
  const address = pubHash.slice(0, 40); // 20-byte address

  return { privHex, pubHex: bufToHex(pubRaw), address };
}

async function recoverAddress(privHex) {
  try {
    const privBuf = hexToBuf(privHex);
    const privKey = await crypto.subtle.importKey(
      "pkcs8", privBuf,
      { name: "ECDSA", namedCurve: "P-256" },
      true, ["sign"]
    );
    // Derive public key by re-exporting (ECDSA doesn't directly give pub from priv,
    // but we can sign + verify pattern; simpler: we store pubHex alongside)
    // Actually: we re-derive by generating a JWK round-trip
    const jwk = await crypto.subtle.exportKey("jwk", privKey);
    // Remove private component to get public JWK
    const pubJwk = { ...jwk, d: undefined, key_ops: ["verify"] };
    delete pubJwk.d;
    const pubKey = await crypto.subtle.importKey(
      "jwk", pubJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true, ["verify"]
    );
    const pubRaw = await crypto.subtle.exportKey("spki", pubKey);
    const pubHash = await hashBuffer(pubRaw);
    return pubHash.slice(0, 40);
  } catch (e) {
    console.error("Key recovery failed:", e);
    return null;
  }
}

async function signChallenge(privHex, challenge) {
  try {
    const privBuf = hexToBuf(privHex);
    const privKey = await crypto.subtle.importKey(
      "pkcs8", privBuf,
      { name: "ECDSA", namedCurve: "P-256" },
      false, ["sign"]
    );
    const data = new TextEncoder().encode(challenge);
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privKey, data
    );
    return bufToHex(sig);
  } catch { return null; }
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex) {
  const bytes = hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || [];
  return new Uint8Array(bytes).buffer;
}

async function hashBuffer(buf) {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return bufToHex(hash);
}

// ── Avatar sigil (consistent with other F1R3 games) ──────────────
function hashSeed(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function AvatarSigil({ seed, size = 64 }) {
  const s = seed % 10000;
  const hue1 = s % 360;
  const hue2 = (s * 7 + 120) % 360;
  const r = size * 0.38;
  const shapes = [];
  for (let i = 0; i < 5; i++) {
    const angle = ((Math.PI * 2) / 5) * i + ((s * (i + 1)) % 60) * 0.02;
    const dist = r * 0.3 + ((s * (i + 3)) % 40) * r * 0.012;
    const cx = size / 2 + Math.cos(angle) * dist;
    const cy = size / 2 + Math.sin(angle) * dist;
    const sr = 4 + ((s * (i + 2)) % 8);
    shapes.push(
      <circle key={`c${i}`} cx={cx} cy={cy} r={sr}
        fill={`hsl(${i % 2 === 0 ? hue1 : hue2}, 70%, 65%)`} opacity={0.85} />
    );
  }
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = ((Math.PI * 2) / 6) * i + (s % 30) * 0.05;
    const d = r * 0.25 + ((s * (i + 1)) % 20) * 0.5;
    pts.push(`${size / 2 + Math.cos(angle) * d},${size / 2 + Math.sin(angle) * d}`);
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r}
        fill={`hsl(${hue1}, 25%, 15%)`} stroke={`hsl(${hue1}, 50%, 40%)`} strokeWidth="1.5" />
      {shapes}
      <polygon points={pts.join(" ")} fill="none"
        stroke={`hsl(${hue2}, 60%, 70%)`} strokeWidth="1.2" opacity="0.7" />
    </svg>
  );
}

// ── Game cards ────────────────────────────────────────────────────
const GAMES = [
  {
    id: "f1r3pix",
    name: "F1R3Pix",
    accent: "#FF6B2B",
    tagline: "Collective Visual Intelligence",
    desc: "Co-create pixel art on a shared canvas. Every placement is a vote for what the community sees.",
    icon: "grid",
  },
  {
    id: "f1r3beat",
    name: "F1R3Beat",
    accent: "#BF5AF2",
    tagline: "Collective Rhythmic Intelligence",
    desc: "Evolve music snippets together. Fork, mutate, and select beats through communal curation.",
    icon: "wave",
  },
  {
    id: "f1r3ink",
    name: "F1R3Ink",
    accent: "#FF2D55",
    tagline: "Collective Emotional Intelligence",
    desc: "Color each other with feeling. Build freak flags of chromatic perception, no words needed.",
    icon: "drop",
  },
  {
    id: "f1r3skein",
    name: "F1R3Skein",
    accent: "#30D158",
    tagline: "Collective Narrative Intelligence",
    desc: "Weave threads of story together. Branch, braid, and bind narratives across the community.",
    icon: "thread",
  },
];

function GameIcon({ icon, size = 32, color }) {
  if (icon === "grid") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {[0, 1, 2, 3].map((r) =>
        [0, 1, 2, 3].map((c) => (
          <rect key={`${r}${c}`} x={2 + c * 7.5} y={2 + r * 7.5} width={6} height={6} rx={1}
            fill={color} opacity={0.3 + ((r + c) % 3) * 0.25} />
        ))
      )}
    </svg>
  );
  if (icon === "wave") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M3 16 C7 8, 11 24, 16 16 C21 8, 25 24, 29 16" stroke={color} strokeWidth="2.5"
        strokeLinecap="round" fill="none" opacity="0.8" />
      <path d="M3 20 C7 12, 11 28, 16 20 C21 12, 25 28, 29 20" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" fill="none" opacity="0.4" />
    </svg>
  );
  if (icon === "drop") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M16 4 C16 4, 6 16, 6 21 C6 26.5 10.5 28 16 28 C21.5 28 26 26.5 26 21 C26 16 16 4 16 4Z"
        fill={color} opacity="0.7" />
      <ellipse cx="12" cy="19" rx="2.5" ry="3" fill="white" opacity="0.25" />
    </svg>
  );
  if (icon === "thread") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M6 6 C12 10, 20 4, 26 10 C20 16, 12 12, 6 18 C12 22, 20 18, 26 26"
        stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.8" />
      <circle cx="6" cy="6" r="2" fill={color} opacity="0.6" />
      <circle cx="26" cy="26" r="2" fill={color} opacity="0.6" />
    </svg>
  );
  return null;
}

// ── Copy button ──────────────────────────────────────────────────
function CopyButton({ text, label = "copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <button onClick={copy} style={{
      background: "none", border: "1px solid #2a2a4a", color: copied ? "#30D158" : "#555",
      borderRadius: 4, padding: "3px 10px", fontSize: 10, cursor: "pointer",
      fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1,
      transition: "all 0.2s",
    }}>
      {copied ? "COPIED" : label.toUpperCase()}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════
export default function F1R3Games() {
  const [phase, setPhase] = useState("loading"); // loading | landing | create | login | dashboard
  const [privKey, setPrivKey] = useState(null);
  const [address, setAddress] = useState(null);
  const [account, setAccount] = useState(null);
  const [allAccounts, setAllAccounts] = useState([]);
  const [error, setError] = useState(null);
  const [loginKey, setLoginKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newTags, setNewTags] = useState("");
  const [showPrivKey, setShowPrivKey] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTags, setEditTags] = useState("");
  const [shardOk, setShardOk] = useState(false);

  // ── Init: check for existing local session ───────────────────
  useEffect(() => {
    (async () => {
      try {
        const savedPriv = await sh.get(LOCAL_PRIVKEY, false);
        const savedAddr = await sh.get(LOCAL_ADDRESS, false);
        if (savedPriv && savedAddr) {
          const acct = await sh.get(`${ACCOUNT_PREFIX}${savedAddr}`);
          if (acct) {
            setPrivKey(savedPriv);
            setAddress(savedAddr);
            setAccount(acct);
            // Update lastSeen
            await sh.set(`${ACCOUNT_PREFIX}${savedAddr}`, { ...acct, lastSeen: Date.now() });
            await loadAllAccounts();
            setShardOk(true);
            setPhase("dashboard");
            return;
          }
        }
      } catch {}
      // Try loading accounts to show count on landing
      await loadAllAccounts();
      setPhase("landing");
    })();
  }, []);

  const loadAllAccounts = async () => {
    const keys = await sh.list(ACCOUNT_PREFIX);
    const accts = [];
    for (const k of keys) {
      const a = await sh.get(k);
      if (a) accts.push(a);
    }
    accts.sort((a, b) => a.createdAt - b.createdAt);
    setAllAccounts(accts);
    setShardOk(true);
    return accts;
  };

  // ── Create account ───────────────────────────────────────────
  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) { setError("name required"); return; }
    setError(null);

    try {
      const kp = await generateKeypair();
      const tags = newTags.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
      const acct = {
        address: kp.address,
        name,
        tags,
        avatarSeed: hashSeed(kp.address),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        games: [],
      };

      await sh.set(`${ACCOUNT_PREFIX}${kp.address}`, acct);
      await sh.set(LOCAL_PRIVKEY, kp.privHex, false);
      await sh.set(LOCAL_ADDRESS, kp.address, false);

      setPrivKey(kp.privHex);
      setAddress(kp.address);
      setAccount(acct);
      await loadAllAccounts();
      setPhase("dashboard");
    } catch (e) {
      setError("keypair generation failed: " + e.message);
    }
  };

  // ── Login with private key ───────────────────────────────────
  const handleLogin = async () => {
    const key = loginKey.trim();
    if (!key) { setError("paste your private key"); return; }
    setError(null);

    try {
      const addr = await recoverAddress(key);
      if (!addr) { setError("invalid key — could not derive address"); return; }

      const acct = await sh.get(`${ACCOUNT_PREFIX}${addr}`);
      if (!acct) { setError(`no account at address ${addr.slice(0, 12)}...`); return; }

      // Verify ownership by signing a challenge
      const challenge = `f1r3-auth-${Date.now()}`;
      const sig = await signChallenge(key, challenge);
      if (!sig) { setError("signing failed — key may be malformed"); return; }

      // Success
      await sh.set(LOCAL_PRIVKEY, key, false);
      await sh.set(LOCAL_ADDRESS, addr, false);
      await sh.set(`${ACCOUNT_PREFIX}${addr}`, { ...acct, lastSeen: Date.now() });

      setPrivKey(key);
      setAddress(addr);
      setAccount(acct);
      await loadAllAccounts();
      setPhase("dashboard");
    } catch (e) {
      setError("login failed: " + e.message);
    }
  };

  // ── Update profile ───────────────────────────────────────────
  const handleUpdateProfile = async () => {
    const name = editName.trim();
    if (!name || !account) return;
    const tags = editTags.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const updated = { ...account, name, tags };
    await sh.set(`${ACCOUNT_PREFIX}${address}`, updated);
    setAccount(updated);
    setEditingProfile(false);
    await loadAllAccounts();
  };

  // ── Logout ───────────────────────────────────────────────────
  const handleLogout = async () => {
    await sh.set(LOCAL_PRIVKEY, null, false);
    await sh.set(LOCAL_ADDRESS, null, false);
    setPrivKey(null);
    setAddress(null);
    setAccount(null);
    setShowPrivKey(false);
    setPhase("landing");
  };

  // ── Delete account ───────────────────────────────────────────
  const handleDelete = async () => {
    if (!address) return;
    await sh.del(`${ACCOUNT_PREFIX}${address}`);
    await handleLogout();
    await loadAllAccounts();
  };

  // ── Shared styles ────────────────────────────────────────────
  const inputStyle = {
    background: "#0d0d1a", border: "1px solid #1e1e3a", borderRadius: 6,
    color: "#ccc", padding: "10px 14px", fontSize: 13, width: "100%",
    fontFamily: "'JetBrains Mono', monospace", outline: "none",
    transition: "border-color 0.2s",
  };
  const btnPrimary = {
    background: "#FF6B2B", color: "#fff", border: "none", borderRadius: 6,
    padding: "10px 28px", fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 600, cursor: "pointer", letterSpacing: 2,
    boxShadow: "0 0 24px #FF6B2B33", transition: "transform 0.1s",
  };
  const btnGhost = {
    background: "none", border: "1px solid #2a2a4a", color: "#666",
    borderRadius: 6, padding: "8px 20px", fontSize: 12, cursor: "pointer",
    fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1,
    transition: "all 0.2s",
  };

  // ════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════
  return (
    <div style={{
      minHeight: "100vh", background: "#08080f",
      color: "#ccc", fontFamily: "'JetBrains Mono', 'DM Mono', monospace",
      display: "flex", flexDirection: "column",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap');
        @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes slideIn { from { opacity:0; transform:translateX(-8px); } to { opacity:1; transform:translateX(0); } }
        @keyframes pulse { 0%,100% { opacity:0.3; } 50% { opacity:1; } }
        @keyframes breathe { 0%,100% { opacity:0.5; } 50% { opacity:1; } }
        @keyframes glowPulse { 0%,100% { box-shadow: 0 0 8px #FF6B2B22; } 50% { box-shadow: 0 0 20px #FF6B2B44; } }
        @keyframes scanline {
          0% { background-position: 0 0; }
          100% { background-position: 0 4px; }
        }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:#1e1e3a; border-radius:2px; }
        * { box-sizing:border-box; }
        input:focus { border-color: #FF6B2B66 !important; }
        button:hover { opacity: 0.9; }
      `}</style>

      {/* Noise texture overlay */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, #08080f11 2px, #08080f11 4px)",
        opacity: 0.3,
      }} />

      <div style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", flexDirection: "column" }}>

        {/* ── LOADING ──────────────────────────────────────────── */}
        {phase === "loading" && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ color: "#444", fontSize: 12, letterSpacing: 3, animation: "pulse 1.5s ease-in-out infinite" }}>
              CONNECTING TO SHARD...
            </div>
          </div>
        )}

        {/* ── LANDING ──────────────────────────────────────────── */}
        {phase === "landing" && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            padding: "40px 20px", animation: "fadeIn 0.6s ease-out",
          }}>
            {/* Logo */}
            <div style={{ textAlign: "center", marginBottom: 48 }}>
              <h1 style={{
                margin: 0, fontSize: 36, fontWeight: 300, letterSpacing: 8,
                color: "#666", fontFamily: "'Noto Serif', serif",
              }}>
                F1R3<span style={{ color: "#FF6B2B", fontWeight: 700 }}>Games</span>
              </h1>
              <div style={{ fontSize: 10, color: "#333", marginTop: 6, letterSpacing: 3 }}>
                SHARD-NATIVE IDENTITY FOR COLLECTIVE INTELLIGENCE
              </div>
              {allAccounts.length > 0 && (
                <div style={{ fontSize: 10, color: "#2a2a4a", marginTop: 12 }}>
                  {allAccounts.length} identity{allAccounts.length !== 1 ? "ies" : ""} on shard
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
              <button onClick={() => { setError(null); setPhase("create"); }}
                style={{ ...btnPrimary, animation: "glowPulse 3s ease-in-out infinite" }}>
                CREATE IDENTITY
              </button>
              <button onClick={() => { setError(null); setLoginKey(""); setPhase("login"); }}
                style={btnGhost}>
                LOGIN WITH KEY
              </button>
            </div>

            {/* Shard indicator */}
            <div style={{
              marginTop: 48, display: "flex", alignItems: "center", gap: 6,
              fontSize: 9, color: "#333", letterSpacing: 2,
            }}>
              <div style={{
                width: 5, height: 5, borderRadius: "50%",
                background: shardOk ? "#30D158" : "#FF453A",
                boxShadow: shardOk ? "0 0 6px #30D15844" : "none",
                animation: shardOk ? "breathe 2s infinite" : "none",
              }} />
              SHARD {shardOk ? "ONLINE" : "OFFLINE"}
            </div>
          </div>
        )}

        {/* ── CREATE IDENTITY ──────────────────────────────────── */}
        {phase === "create" && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            padding: "40px 20px", animation: "fadeIn 0.4s ease-out",
          }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 24 }}>
              CREATE SHARD IDENTITY
            </div>

            <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="display name" style={inputStyle} />
              <input value={newTags} onChange={(e) => setNewTags(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="tags (comma-separated): builder, dreamer..."
                style={{ ...inputStyle, fontSize: 11, color: "#888" }} />

              <div style={{ fontSize: 9, color: "#333", lineHeight: 1.6, padding: "4px 2px" }}>
                A cryptographic keypair will be generated. Your private key is your
                sole credential — save it to log in from other devices. No email,
                no password, no recovery.
              </div>

              {error && (
                <div style={{ color: "#FF453A", fontSize: 11, textAlign: "center" }}>{error}</div>
              )}

              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 8 }}>
                <button onClick={handleCreate} style={btnPrimary}>GENERATE</button>
                <button onClick={() => setPhase("landing")} style={btnGhost}>BACK</button>
              </div>
            </div>
          </div>
        )}

        {/* ── LOGIN WITH KEY ───────────────────────────────────── */}
        {phase === "login" && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            padding: "40px 20px", animation: "fadeIn 0.4s ease-out",
          }}>
            <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 24 }}>
              LOGIN WITH PRIVATE KEY
            </div>

            <div style={{ width: "100%", maxWidth: 400, display: "flex", flexDirection: "column", gap: 12 }}>
              <textarea value={loginKey} onChange={(e) => setLoginKey(e.target.value)}
                placeholder="paste your private key hex..."
                rows={4}
                style={{
                  ...inputStyle, resize: "vertical", fontSize: 10,
                  lineHeight: 1.5, wordBreak: "break-all",
                }} />

              <div style={{ fontSize: 9, color: "#333", lineHeight: 1.6, padding: "4px 2px" }}>
                Your address will be derived from the key. The shard will verify
                the account exists and authenticate via challenge signing.
              </div>

              {error && (
                <div style={{ color: "#FF453A", fontSize: 11, textAlign: "center" }}>{error}</div>
              )}

              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 8 }}>
                <button onClick={handleLogin} style={btnPrimary}>AUTHENTICATE</button>
                <button onClick={() => setPhase("landing")} style={btnGhost}>BACK</button>
              </div>
            </div>
          </div>
        )}

        {/* ── DASHBOARD ────────────────────────────────────────── */}
        {phase === "dashboard" && account && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            overflow: "hidden", animation: "fadeIn 0.5s ease-out",
          }}>
            {/* Header bar */}
            <header style={{
              padding: "12px 20px", borderBottom: "1px solid #12121f",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <h1 style={{ margin: 0, fontSize: 18, fontWeight: 300, letterSpacing: 4,
                  color: "#666", fontFamily: "'Noto Serif', serif" }}>
                  F1R3<span style={{ color: "#FF6B2B", fontWeight: 700 }}>Games</span>
                </h1>
                <div style={{
                  width: 5, height: 5, borderRadius: "50%", background: "#30D158",
                  boxShadow: "0 0 6px #30D15844", animation: "breathe 2s infinite",
                }} />
              </div>
              <button onClick={handleLogout} style={{
                ...btnGhost, fontSize: 10, padding: "4px 12px",
              }}>LOGOUT</button>
            </header>

            {/* Main content: identity card + game grid */}
            <div style={{ flex: 1, overflow: "auto", padding: "24px 20px" }}>

              {/* Identity card */}
              <div style={{
                background: "#0c0c18", border: "1px solid #1a1a30",
                borderRadius: 12, padding: "20px 24px", marginBottom: 32,
                maxWidth: 600, margin: "0 auto 32px",
              }}>
                <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                  <AvatarSigil seed={account.avatarSeed || hashSeed(address)} size={64} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {!editingProfile ? (
                      <>
                        <div style={{ fontSize: 18, color: "#ddd", fontWeight: 600, marginBottom: 4 }}>
                          {account.name}
                        </div>
                        {account.tags?.length > 0 && (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                            {account.tags.map((t, i) => (
                              <span key={i} style={{
                                background: "#12122a", border: "1px solid #1e1e3a",
                                borderRadius: 3, padding: "1px 8px", fontSize: 10, color: "#7777aa",
                              }}>{t}</span>
                            ))}
                          </div>
                        )}
                        <button onClick={() => {
                          setEditName(account.name);
                          setEditTags(account.tags?.join(", ") || "");
                          setEditingProfile(true);
                        }} style={{ ...btnGhost, fontSize: 9, padding: "2px 10px" }}>
                          EDIT PROFILE
                        </button>
                      </>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <input value={editName} onChange={(e) => setEditName(e.target.value)}
                          placeholder="name" style={{ ...inputStyle, fontSize: 13 }} />
                        <input value={editTags} onChange={(e) => setEditTags(e.target.value)}
                          placeholder="tags" style={{ ...inputStyle, fontSize: 11 }} />
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={handleUpdateProfile}
                            style={{ ...btnGhost, fontSize: 9, padding: "3px 10px", color: "#30D158", borderColor: "#30D15844" }}>
                            SAVE
                          </button>
                          <button onClick={() => setEditingProfile(false)}
                            style={{ ...btnGhost, fontSize: 9, padding: "3px 10px" }}>
                            CANCEL
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Address + key section */}
                <div style={{
                  marginTop: 16, paddingTop: 16, borderTop: "1px solid #1a1a30",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ fontSize: 9, color: "#444", letterSpacing: 2 }}>SHARD ADDRESS</div>
                    <CopyButton text={address} label="copy" />
                  </div>
                  <div style={{
                    fontSize: 11, color: "#FF6B2B", wordBreak: "break-all",
                    fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.5,
                    background: "#0a0a12", padding: "6px 8px", borderRadius: 4,
                  }}>
                    {address}
                  </div>

                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    marginTop: 12, marginBottom: 6,
                  }}>
                    <div style={{ fontSize: 9, color: "#444", letterSpacing: 2 }}>PRIVATE KEY</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => setShowPrivKey(!showPrivKey)}
                        style={{ ...btnGhost, fontSize: 9, padding: "2px 8px" }}>
                        {showPrivKey ? "HIDE" : "REVEAL"}
                      </button>
                      {showPrivKey && <CopyButton text={privKey} label="copy" />}
                    </div>
                  </div>
                  {showPrivKey ? (
                    <div style={{
                      fontSize: 9, color: "#FF453A", wordBreak: "break-all",
                      fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.4,
                      background: "#0a0a12", padding: "6px 8px", borderRadius: 4,
                      border: "1px solid #FF453A22",
                    }}>
                      {privKey}
                    </div>
                  ) : (
                    <div style={{
                      fontSize: 10, color: "#222", background: "#0a0a12",
                      padding: "6px 8px", borderRadius: 4, letterSpacing: 4,
                    }}>
                      {"•".repeat(32)}
                    </div>
                  )}
                  <div style={{ fontSize: 8, color: "#FF453A44", marginTop: 4 }}>
                    Save this key. It is your only way to recover this identity.
                  </div>
                </div>

                {/* Metadata */}
                <div style={{
                  marginTop: 12, display: "flex", gap: 16, fontSize: 9, color: "#333",
                }}>
                  <span>created {new Date(account.createdAt).toLocaleDateString()}</span>
                  <span>last seen {new Date(account.lastSeen).toLocaleTimeString()}</span>
                </div>
              </div>

              {/* Game grid */}
              <div style={{ maxWidth: 600, margin: "0 auto" }}>
                <div style={{ fontSize: 10, color: "#444", letterSpacing: 3, marginBottom: 16, textAlign: "center" }}>
                  ENTER A GAME
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {GAMES.map((g, idx) => (
                    <div key={g.id}
                      style={{
                        background: "#0c0c18", border: `1px solid ${g.accent}22`,
                        borderRadius: 10, padding: "16px 14px", cursor: "pointer",
                        transition: "all 0.25s",
                        animation: `slideIn 0.4s ${idx * 0.08}s ease-out both`,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = g.accent + "66";
                        e.currentTarget.style.boxShadow = `0 0 16px ${g.accent}22`;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = g.accent + "22";
                        e.currentTarget.style.boxShadow = "none";
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <GameIcon icon={g.icon} size={24} color={g.accent} />
                        <span style={{ fontSize: 14, fontWeight: 600, color: g.accent, letterSpacing: 1 }}>
                          {g.name}
                        </span>
                      </div>
                      <div style={{ fontSize: 9, color: "#555", letterSpacing: 1, marginBottom: 6 }}>
                        {g.tagline.toUpperCase()}
                      </div>
                      <div style={{ fontSize: 10, color: "#444", lineHeight: 1.5 }}>
                        {g.desc}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Community on shard */}
              {allAccounts.length > 1 && (
                <div style={{ maxWidth: 600, margin: "32px auto 0", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#333", letterSpacing: 2, marginBottom: 12 }}>
                    IDENTITIES ON SHARD
                  </div>
                  <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                    {allAccounts.map((a) => (
                      <div key={a.address} style={{
                        display: "flex", alignItems: "center", gap: 4,
                        opacity: a.address === address ? 1 : 0.5,
                      }}>
                        <AvatarSigil seed={a.avatarSeed || hashSeed(a.address)} size={22} />
                        <span style={{
                          fontSize: 10,
                          color: a.address === address ? "#FF6B2B" : "#555",
                        }}>{a.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Danger zone */}
              <div style={{
                maxWidth: 600, margin: "40px auto 20px", textAlign: "center",
                paddingTop: 20, borderTop: "1px solid #1a1a2a",
              }}>
                <button onClick={handleDelete}
                  style={{
                    ...btnGhost, fontSize: 9, color: "#FF453A44", borderColor: "#FF453A22",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "#FF453A"; e.currentTarget.style.borderColor = "#FF453A66"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "#FF453A44"; e.currentTarget.style.borderColor = "#FF453A22"; }}
                >
                  DELETE IDENTITY
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
