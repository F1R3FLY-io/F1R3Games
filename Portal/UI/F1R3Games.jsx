import { useState, useEffect, useCallback, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
// F1R3Games — Unified Shard-Native Auth, Social Graph & Game Lobby
//
// Extended shard key schema:
//   f1r3-account:{address}                    → player profile
//   f1r3-auth-privkey / f1r3-auth-address     → local session
//   f1r3-contact:{ownerAddr}:{contactId}      → contact record
//   f1r3-session:{sessionId}                  → game session/lobby
//   f1r3-invite:{sessionId}:{contactId}       → invitation record
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
  async getLocal(k) {
    try { const r = await window.storage.get(k, false); return r?.value ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async setLocal(k, v) {
    try { await window.storage.set(k, JSON.stringify(v), false); return true; }
    catch { return false; }
  },
};

const ACCT_PFX = "f1r3-account:";
const CONTACT_PFX = "f1r3-contact:";
const SESSION_PFX = "f1r3-session:";
const INVITE_PFX = "f1r3-invite:";
const LOCAL_PRIV = "f1r3-auth-privkey";
const LOCAL_ADDR = "f1r3-auth-address";

// ── Brand colors (from Brand Book V1.0) ──────────────────────────
const BRAND = {
  yellow: "#F3D630",
  sage: "#8BB999",
  sky: "#3FA9F5",
  black: "#000000",
  surface: "#08080f",
  surfaceCard: "#0c0c18",
  border: "#1a1a30",
  textPrimary: "#ffffff",
  textSecondary: "#999999",
  textMuted: "#555555",
  textDim: "#333333",
  gradientPrimary: "linear-gradient(90deg, #F3D630, #8BB999, #3FA9F5)",
  clientGrad: "linear-gradient(135deg, #5c0269, #7b0429)",
  devGrad: "linear-gradient(135deg, #007bc4, #009188)",
  partnerGrad: "linear-gradient(135deg, #0c8e23, #7a9d0e)",
  neutralGrad: "linear-gradient(135deg, #3f3f3f, #2e31ae)",
};

// ── F1R3FLY Logomark (actual brand asset) ────────────────────────
const F1R3FLY_LOGO_URI = "data:image/png;base64,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";

function F1R3FLYLogo({ size = 48 }) {
  return (
    <img src={F1R3FLY_LOGO_URI} width={size} height={size}
      alt="F1R3FLY" style={{ objectFit: "contain", display: "block" }} />
  );
}


// ── Wordmark ─────────────────────────────────────────────────────
function F1R3FLYWordmark({ size = 14 }) {
  return (
    <span style={{
      fontSize: size, fontWeight: 700, letterSpacing: 2,
      fontFamily: "'Brandon Grotesque', sans-serif", color: "#fff",
    }}>
      F1R3FLY<span style={{ color: BRAND.sage }}>.IO</span>
    </span>
  );
}

// ── Brand header bar (reusable across all pages) ─────────────────
function BrandHeader({ right, subtitle }) {
  return (
    <header style={{
      padding: "10px 20px", borderBottom: `1px solid ${BRAND.border}`,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "linear-gradient(180deg, #0c0c18 0%, #08080f 100%)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <F1R3FLYLogo size={32} />
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 300, letterSpacing: 4,
              color: "#888", fontFamily: "'Brandon Grotesque', sans-serif" }}>
              F1R3<span style={{ color: BRAND.sky, fontWeight: 700 }}>Games</span>
            </span>
          </div>
          {subtitle && (
            <div style={{ fontSize: 9, color: BRAND.textDim, letterSpacing: 2, marginTop: 1 }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {right && <div>{right}</div>}
    </header>
  );
}

// ── Crypto ───────────────────────────────────────────────────────
async function generateKeypair() {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const priv = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const pub = await crypto.subtle.exportKey("spki", kp.publicKey);
  const privHex = bufHex(priv);
  const addr = (await hashBuf(pub)).slice(0, 40);
  return { privHex, address: addr };
}

async function recoverAddress(privHex) {
  try {
    const pk = await crypto.subtle.importKey("pkcs8", hexBuf(privHex),
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", pk);
    const pubJwk = { ...jwk, d: undefined, key_ops: ["verify"] }; delete pubJwk.d;
    const pubKey = await crypto.subtle.importKey("jwk", pubJwk,
      { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    const pub = await crypto.subtle.exportKey("spki", pubKey);
    return (await hashBuf(pub)).slice(0, 40);
  } catch { return null; }
}

async function signChallenge(privHex, ch) {
  try {
    const pk = await crypto.subtle.importKey("pkcs8", hexBuf(privHex),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
      pk, new TextEncoder().encode(ch));
    return bufHex(sig);
  } catch { return null; }
}

function bufHex(b) { return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function hexBuf(h) { return new Uint8Array(h.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || []).buffer; }
async function hashBuf(b) { return bufHex(await crypto.subtle.digest("SHA-256", b)); }
function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

// ── Avatar ───────────────────────────────────────────────────────
function hSeed(id) { let h = 0; for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0; return Math.abs(h); }

function Sigil({ seed, size = 64 }) {
  const s = seed % 10000, h1 = s % 360, h2 = (s * 7 + 120) % 360, r = size * 0.38;
  const shapes = [];
  for (let i = 0; i < 5; i++) {
    const a = ((Math.PI * 2) / 5) * i + ((s * (i + 1)) % 60) * 0.02;
    const d = r * 0.3 + ((s * (i + 3)) % 40) * r * 0.012;
    shapes.push(<circle key={i} cx={size/2+Math.cos(a)*d} cy={size/2+Math.sin(a)*d}
      r={4+((s*(i+2))%8)} fill={`hsl(${i%2===0?h1:h2},70%,65%)`} opacity={0.85}/>);
  }
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = ((Math.PI * 2) / 6) * i + (s % 30) * 0.05;
    pts.push(`${size/2+Math.cos(a)*(r*0.25+((s*(i+1))%20)*0.5)},${size/2+Math.sin(a)*(r*0.25+((s*(i+1))%20)*0.5)}`);
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill={`hsl(${h1},25%,15%)`} stroke={`hsl(${h1},50%,40%)`} strokeWidth="1.5"/>
      {shapes}
      <polygon points={pts.join(" ")} fill="none" stroke={`hsl(${h2},60%,70%)`} strokeWidth="1.2" opacity="0.7"/>
    </svg>
  );
}

// ── Game defs ────────────────────────────────────────────────────
const GAMES = [
  { id: "f1r3pix", name: "F1R3Pix", accent: "#F3D630", tag: "Collective Visual Intelligence",
    desc: "Co-create pixel art on a shared canvas.", icon: "grid" },
  { id: "f1r3beat", name: "F1R3Beat", accent: "#BF5AF2", tag: "Collective Rhythmic Intelligence",
    desc: "Evolve music snippets together through communal curation.", icon: "wave" },
  { id: "f1r3ink", name: "F1R3Ink", accent: "#FF2D55", tag: "Collective Emotional Intelligence",
    desc: "Color each other with feeling. Build freak flags of chromatic perception.", icon: "drop" },
  { id: "f1r3skein", name: "F1R3Skein", accent: "#30D158", tag: "Collective Narrative Intelligence",
    desc: "Weave threads of story. Branch, braid, and bind narratives.", icon: "thread" },
];

function GIcon({ icon, size = 24, color }) {
  if (icon === "grid") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {[0,1,2,3].map(r=>[0,1,2,3].map(c=>(
        <rect key={`${r}${c}`} x={2+c*7.5} y={2+r*7.5} width={6} height={6} rx={1}
          fill={color} opacity={0.3+((r+c)%3)*0.25}/>)))}
    </svg>);
  if (icon === "wave") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M3 16C7 8,11 24,16 16C21 8,25 24,29 16" stroke={color} strokeWidth="2.5" strokeLinecap="round" opacity="0.8"/>
      <path d="M3 20C7 12,11 28,16 20C21 12,25 28,29 20" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.4"/>
    </svg>);
  if (icon === "drop") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M16 4C16 4,6 16,6 21C6 26.5 10.5 28 16 28C21.5 28 26 26.5 26 21C26 16 16 4 16 4Z" fill={color} opacity="0.7"/>
      <ellipse cx="12" cy="19" rx="2.5" ry="3" fill="white" opacity="0.25"/>
    </svg>);
  if (icon === "thread") return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M6 6C12 10,20 4,26 10C20 16,12 12,6 18C12 22,20 18,26 26" stroke={color} strokeWidth="2" strokeLinecap="round" opacity="0.8"/>
      <circle cx="6" cy="6" r="2" fill={color} opacity="0.6"/><circle cx="26" cy="26" r="2" fill={color} opacity="0.6"/>
    </svg>);
  return null;
}

// ── Copy button ──────────────────────────────────────────────────
function CopyBtn({ text, label = "COPY" }) {
  const [ok, setOk] = useState(false);
  const go = async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement("textarea"); t.value = text;
      document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t);
    }
    setOk(true); setTimeout(() => setOk(false), 1500);
  };
  return <button onClick={go} style={{...sGhost, fontSize:9, padding:"2px 8px",
    color: ok ? "#30D158" : "#555"}}>{ok ? "COPIED" : label}</button>;
}

// ── Shared styles ────────────────────────────────────────────────
const sInput = {
  background: "#0d0d1a", border: "1px solid #1e1e3a", borderRadius: 6,
  color: "#ccc", padding: "10px 14px", fontSize: 13, width: "100%",
  fontFamily: "'Brandon Grotesque', 'JetBrains Mono', sans-serif", outline: "none", transition: "border-color 0.2s",
};
const sPrimary = {
  background: "#3FA9F5", color: "#fff", border: "none", borderRadius: 6,
  padding: "10px 28px", fontSize: 13, fontFamily: "'Brandon Grotesque', 'JetBrains Mono', sans-serif",
  fontWeight: 600, cursor: "pointer", letterSpacing: 2,
  boxShadow: "0 0 24px #3FA9F533", transition: "transform 0.1s",
};
const sGhost = {
  background: "none", border: "1px solid #2a2a4a", color: "#666",
  borderRadius: 6, padding: "8px 20px", fontSize: 12, cursor: "pointer",
  fontFamily: "'Brandon Grotesque', 'JetBrains Mono', sans-serif", letterSpacing: 1, transition: "all 0.2s",
};

// ── Contact source definitions ───────────────────────────────────
const SOURCES = [
  { id: "email", name: "Email", icon: "✉", desc: "Add email contacts manually or paste CSV", accent: "#40C8E0" },
  { id: "twitter", name: "X / Twitter", icon: "𝕏", desc: "Add by handle — invites sent as DM link", accent: "#1DA1F2" },
  { id: "discord", name: "Discord", icon: "◈", desc: "Add by username — invites as DM link", accent: "#5865F2" },
  { id: "telegram", name: "Telegram", icon: "✈", desc: "Add by username — invites as message link", accent: "#26A5E4" },
  { id: "manual", name: "Manual", icon: "＋", desc: "Add any contact with a name and handle", accent: "#8E8E93" },
];

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════
export default function F1R3Games() {
  // ── Phases: loading → landing → create → login → dashboard
  //            dashboard → startGame → importContacts → selectInvites → sendInvites → lobby
  const [phase, setPhase] = useState("loading");
  const [privKey, setPrivKey] = useState(null);
  const [address, setAddress] = useState(null);
  const [account, setAccount] = useState(null);
  const [allAccounts, setAllAccounts] = useState([]);
  const [error, setError] = useState(null);

  // Auth forms
  const [loginKey, setLoginKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newTags, setNewTags] = useState("");

  // Profile edit
  const [showPrivKey, setShowPrivKey] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTags, setEditTags] = useState("");

  // Game launch flow
  const [selectedGame, setSelectedGame] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [contacts, setContacts] = useState([]); // loaded from shard
  const [importSource, setImportSource] = useState(null);
  const [importDraft, setImportDraft] = useState("");
  const [csvDraft, setCsvDraft] = useState("");
  const [selectedInvites, setSelectedInvites] = useState(new Set());
  const [invitesSent, setInvitesSent] = useState([]);
  const [shardOk, setShardOk] = useState(false);

  // ── Load helpers ─────────────────────────────────────────────
  const loadAllAccounts = useCallback(async () => {
    const keys = await sh.list(ACCT_PFX);
    const a = [];
    for (const k of keys) { const v = await sh.get(k); if (v) a.push(v); }
    a.sort((x, y) => x.createdAt - y.createdAt);
    setAllAccounts(a);
    setShardOk(true);
    return a;
  }, []);

  const loadMyContacts = useCallback(async (addr) => {
    const keys = await sh.list(`${CONTACT_PFX}${addr}:`);
    const c = [];
    for (const k of keys) { const v = await sh.get(k); if (v) c.push(v); }
    c.sort((x, y) => x.addedAt - y.addedAt);
    setContacts(c);
    return c;
  }, []);

  // ── Init ─────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const sp = await sh.getLocal(LOCAL_PRIV);
        const sa = await sh.getLocal(LOCAL_ADDR);
        if (sp && sa) {
          const acct = await sh.get(`${ACCT_PFX}${sa}`);
          if (acct) {
            setPrivKey(sp); setAddress(sa); setAccount(acct);
            await sh.set(`${ACCT_PFX}${sa}`, { ...acct, lastSeen: Date.now() });
            await loadAllAccounts();
            await loadMyContacts(sa);
            setPhase("dashboard"); return;
          }
        }
      } catch {}
      await loadAllAccounts();
      setPhase("landing");
    })();
  }, []); // eslint-disable-line

  // ── Auth actions ─────────────────────────────────────────────
  const handleCreate = async () => {
    const n = newName.trim(); if (!n) { setError("name required"); return; }
    setError(null);
    try {
      const kp = await generateKeypair();
      const tags = newTags.split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);
      const acct = { address: kp.address, name: n, tags, avatarSeed: hSeed(kp.address),
        createdAt: Date.now(), lastSeen: Date.now() };
      await sh.set(`${ACCT_PFX}${kp.address}`, acct);
      await sh.setLocal(LOCAL_PRIV, kp.privHex);
      await sh.setLocal(LOCAL_ADDR, kp.address);
      setPrivKey(kp.privHex); setAddress(kp.address); setAccount(acct);
      await loadAllAccounts();
      setPhase("dashboard");
    } catch (e) { setError("generation failed: " + e.message); }
  };

  const handleLogin = async () => {
    const k = loginKey.trim(); if (!k) { setError("paste your private key"); return; }
    setError(null);
    try {
      const addr = await recoverAddress(k);
      if (!addr) { setError("invalid key"); return; }
      const acct = await sh.get(`${ACCT_PFX}${addr}`);
      if (!acct) { setError(`no account at ${addr.slice(0,12)}...`); return; }
      const sig = await signChallenge(k, `f1r3-auth-${Date.now()}`);
      if (!sig) { setError("signing failed"); return; }
      await sh.setLocal(LOCAL_PRIV, k); await sh.setLocal(LOCAL_ADDR, addr);
      await sh.set(`${ACCT_PFX}${addr}`, { ...acct, lastSeen: Date.now() });
      setPrivKey(k); setAddress(addr); setAccount(acct);
      await loadAllAccounts(); await loadMyContacts(addr);
      setPhase("dashboard");
    } catch (e) { setError("login failed: " + e.message); }
  };

  const handleLogout = async () => {
    await sh.setLocal(LOCAL_PRIV, null); await sh.setLocal(LOCAL_ADDR, null);
    setPrivKey(null); setAddress(null); setAccount(null); setShowPrivKey(false);
    setPhase("landing");
  };

  const handleUpdateProfile = async () => {
    const n = editName.trim(); if (!n || !account) return;
    const tags = editTags.split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);
    const u = { ...account, name: n, tags };
    await sh.set(`${ACCT_PFX}${address}`, u);
    setAccount(u); setEditingProfile(false); await loadAllAccounts();
  };

  const handleDelete = async () => {
    if (!address) return;
    await sh.del(`${ACCT_PFX}${address}`);
    await handleLogout(); await loadAllAccounts();
  };

  // ── Game session creation ────────────────────────────────────
  const startGameSession = async (game) => {
    const sid = `s-${uid()}`;
    const session = {
      id: sid, game: game.id, gameName: game.name, hostAddr: address,
      hostName: account.name, createdAt: Date.now(), status: "lobby",
    };
    await sh.set(`${SESSION_PFX}${sid}`, session);
    setSelectedGame(game); setSessionId(sid);
    setSelectedInvites(new Set()); setInvitesSent([]);
    setPhase("importContacts");
  };

  // ── Contact import ───────────────────────────────────────────
  const addContact = async (name, handle, channel) => {
    const cid = `c-${uid()}`;
    const contact = { id: cid, name: name.trim(), handle: handle.trim(),
      channel, source: channel, addedAt: Date.now() };
    await sh.set(`${CONTACT_PFX}${address}:${cid}`, contact);
    setContacts(prev => [...prev, contact]);
    return contact;
  };

  const importManualContact = async () => {
    const lines = importDraft.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      // Parse "Name <handle>" or "Name, handle" or just "handle"
      let name = "", handle = "";
      const angleMatch = line.match(/^(.+?)\s*<(.+?)>/);
      const commaMatch = line.match(/^(.+?)\s*,\s*(.+)/);
      if (angleMatch) { name = angleMatch[1]; handle = angleMatch[2]; }
      else if (commaMatch) { name = commaMatch[1]; handle = commaMatch[2]; }
      else { name = line.split("@")[0] || line; handle = line; }
      if (handle) await addContact(name, handle, importSource);
    }
    setImportDraft("");
  };

  const importCsv = async () => {
    const lines = csvDraft.split("\n").filter(l => l.trim());
    for (const line of lines) {
      const parts = line.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      if (parts.length >= 2) {
        const [name, handle] = parts;
        if (handle) await addContact(name, handle, "email");
      } else if (parts.length === 1 && parts[0].includes("@")) {
        await addContact(parts[0].split("@")[0], parts[0], "email");
      }
    }
    setCsvDraft("");
  };

  // ── Invite toggle ────────────────────────────────────────────
  const toggleInvite = (cid) => {
    setSelectedInvites(prev => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedInvites.size === contacts.length) setSelectedInvites(new Set());
    else setSelectedInvites(new Set(contacts.map(c => c.id)));
  };

  // ── Send invitations ─────────────────────────────────────────
  const sendInvites = async () => {
    const game = selectedGame;
    const sent = [];
    for (const cid of selectedInvites) {
      const contact = contacts.find(c => c.id === cid);
      if (!contact) continue;
      const invite = {
        id: `inv-${uid()}`, sessionId, contactId: cid,
        contactName: contact.name, contactHandle: contact.handle,
        channel: contact.channel, hostAddr: address, hostName: account.name,
        game: game.id, gameName: game.name, status: "sent", sentAt: Date.now(),
      };
      await sh.set(`${INVITE_PFX}${sessionId}:${cid}`, invite);
      sent.push({ ...invite, contact });
    }
    setInvitesSent(sent);
    setPhase("sendInvites");
  };

  // ── Build invite message ─────────────────────────────────────
  const buildInviteMsg = (contact, game) => {
    const joinUrl = `f1r3.games/join/${sessionId}`;
    return `${account.name} invited you to play ${game.name} on F1R3Games!\n\n` +
      `"${game.tag}"\n\n` +
      `Join here: ${joinUrl}\n\n` +
      `Session: ${sessionId}\nHost: ${account.name} (${address.slice(0,12)}...)`;
  };

  const getDispatchUrl = (contact, msg) => {
    const enc = encodeURIComponent(msg);
    switch (contact.channel) {
      case "email": return `mailto:${contact.handle}?subject=${encodeURIComponent(`Join me on ${selectedGame?.name}!`)}&body=${enc}`;
      case "twitter": return `https://twitter.com/messages/compose?text=${enc}`;
      case "discord": return null; // no direct DM URL, copy instead
      case "telegram": return `https://t.me/${contact.handle.replace("@","")}?text=${enc}`;
      default: return null;
    }
  };

  // ── Channel icon ─────────────────────────────────────────────
  const channelColor = (ch) => {
    const s = SOURCES.find(s => s.id === ch);
    return s?.accent || "#666";
  };

  const channelLabel = (ch) => {
    const s = SOURCES.find(s => s.id === ch);
    return s?.icon || "?";
  };

  // ══════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════
  return (
    <div style={{
      minHeight: "100vh", background: "#08080f", color: "#ccc",
      fontFamily: "'Brandon Grotesque', 'JetBrains Mono', sans-serif",
      display: "flex", flexDirection: "column",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Noto+Serif:ital,wght@0,400;0,700;1,400&family=Source+Sans+3:wght@300;400;600;700&display=swap');
        @font-face {
          font-family: 'Brandon Grotesque';
          src: local('Brandon Grotesque Medium'), local('BrandonGrotesque-Medium');
          font-weight: 500;
          font-style: normal;
        }
        @font-face {
          font-family: 'Brandon Grotesque';
          src: local('Brandon Grotesque Bold'), local('BrandonGrotesque-Bold');
          font-weight: 700;
          font-style: normal;
        }
        @font-face {
          font-family: 'Brandon Grotesque';
          src: local('Brandon Grotesque Regular'), local('BrandonGrotesque-Regular');
          font-weight: 400;
          font-style: normal;
        }
        @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes slideIn { from { opacity:0; transform:translateX(-8px); } to { opacity:1; transform:translateX(0); } }
        @keyframes pulse { 0%,100%{opacity:.3} 50%{opacity:1} }
        @keyframes breathe { 0%,100%{opacity:.5} 50%{opacity:1} }
        @keyframes glowPulse { 0%,100%{box-shadow:0 0 8px #3FA9F522} 50%{box-shadow:0 0 20px #3FA9F544} }
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#1e1e3a;border-radius:2px}
        *{box-sizing:border-box} input:focus,textarea:focus{border-color:#3FA9F566!important}
        button:hover{opacity:.9}
      `}</style>

      {/* Scanline overlay */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,
        background:"repeating-linear-gradient(0deg,transparent,transparent 2px,#08080f11 2px,#08080f11 4px)",opacity:.3}}/>

      <div style={{position:"relative",zIndex:1,flex:1,display:"flex",flexDirection:"column"}}>

        {/* ── LOADING ──────────────────────────────────────── */}
        {phase === "loading" && (
          <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{color:"#444",fontSize:12,letterSpacing:3,animation:"pulse 1.5s ease-in-out infinite"}}>
              CONNECTING TO SHARD...
            </div>
          </div>
        )}

        {/* ── LANDING ──────────────────────────────────────── */}
        {phase === "landing" && (
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",
            justifyContent:"center",padding:"40px 20px",animation:"fadeIn .6s ease-out"}}>
            <F1R3FLYLogo size={64} />
            <div style={{marginTop:16}}>
              <h1 style={{margin:0,fontSize:36,fontWeight:300,letterSpacing:8,color:"#666",
                fontFamily:"'Brandon Grotesque','Noto Serif',sans-serif"}}>
                F1R3<span style={{color:BRAND.sky,fontWeight:700}}>Games</span>
              </h1>
            </div>
            <div style={{fontSize:10,color:BRAND.textDim,marginTop:6,letterSpacing:3}}>
              SHARD-NATIVE COLLECTIVE INTELLIGENCE
            </div>
            <div style={{marginTop:4}}>
              <F1R3FLYWordmark size={11} />
            </div>
            {allAccounts.length > 0 && (
              <div style={{fontSize:10,color:"#2a2a4a",marginTop:12}}>
                {allAccounts.length} identit{allAccounts.length !== 1 ? "ies" : "y"} on shard
              </div>
            )}
            <div style={{display:"flex",gap:16,flexWrap:"wrap",justifyContent:"center",marginTop:40}}>
              <button onClick={()=>{setError(null);setPhase("create")}}
                style={{...sPrimary,animation:"glowPulse 3s ease-in-out infinite"}}>
                CREATE IDENTITY
              </button>
              <button onClick={()=>{setError(null);setLoginKey("");setPhase("login")}}
                style={sGhost}>LOGIN WITH KEY</button>
            </div>
            <div style={{marginTop:48,display:"flex",alignItems:"center",gap:6,fontSize:9,color:"#333",letterSpacing:2}}>
              <div style={{width:5,height:5,borderRadius:"50%",background:shardOk?"#30D158":"#FF453A",
                boxShadow:shardOk?"0 0 6px #30D15844":"none",animation:shardOk?"breathe 2s infinite":"none"}}/>
              SHARD {shardOk?"ONLINE":"OFFLINE"}
            </div>
          </div>
        )}

        {/* ── CREATE IDENTITY ──────────────────────────────── */}
        {phase === "create" && (
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",
            justifyContent:"center",padding:"40px 20px",animation:"fadeIn .4s ease-out"}}>
            <F1R3FLYLogo size={40} />
            <div style={{fontSize:10,color:"#444",letterSpacing:3,marginBottom:24,marginTop:12}}>CREATE SHARD IDENTITY</div>
            <div style={{width:"100%",maxWidth:340,display:"flex",flexDirection:"column",gap:12}}>
              <input value={newName} onChange={e=>setNewName(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleCreate()} placeholder="display name" style={sInput}/>
              <input value={newTags} onChange={e=>setNewTags(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&handleCreate()}
                placeholder="tags: builder, dreamer..." style={{...sInput,fontSize:11,color:"#888"}}/>
              <div style={{fontSize:9,color:"#333",lineHeight:1.6,padding:"4px 2px"}}>
                A cryptographic keypair will be generated. Your private key is your sole credential.
                No email, no password, no recovery.
              </div>
              {error && <div style={{color:"#FF453A",fontSize:11,textAlign:"center"}}>{error}</div>}
              <div style={{display:"flex",gap:10,justifyContent:"center",marginTop:8}}>
                <button onClick={handleCreate} style={sPrimary}>GENERATE</button>
                <button onClick={()=>setPhase("landing")} style={sGhost}>BACK</button>
              </div>
            </div>
          </div>
        )}

        {/* ── LOGIN ────────────────────────────────────────── */}
        {phase === "login" && (
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",
            justifyContent:"center",padding:"40px 20px",animation:"fadeIn .4s ease-out"}}>
            <F1R3FLYLogo size={40} />
            <div style={{fontSize:10,color:"#444",letterSpacing:3,marginBottom:24,marginTop:12}}>LOGIN WITH PRIVATE KEY</div>
            <div style={{width:"100%",maxWidth:400,display:"flex",flexDirection:"column",gap:12}}>
              <textarea value={loginKey} onChange={e=>setLoginKey(e.target.value)}
                placeholder="paste your private key hex..." rows={4}
                style={{...sInput,resize:"vertical",fontSize:10,lineHeight:1.5,wordBreak:"break-all"}}/>
              <div style={{fontSize:9,color:"#333",lineHeight:1.6}}>
                Your address will be derived from the key and verified against the shard.
              </div>
              {error && <div style={{color:"#FF453A",fontSize:11,textAlign:"center"}}>{error}</div>}
              <div style={{display:"flex",gap:10,justifyContent:"center",marginTop:8}}>
                <button onClick={handleLogin} style={sPrimary}>AUTHENTICATE</button>
                <button onClick={()=>setPhase("landing")} style={sGhost}>BACK</button>
              </div>
            </div>
          </div>
        )}

        {/* ── DASHBOARD ────────────────────────────────────── */}
        {phase === "dashboard" && account && (
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",animation:"fadeIn .5s ease-out"}}>
            <BrandHeader
              subtitle="DASHBOARD"
              right={<button onClick={handleLogout} style={{...sGhost,fontSize:10,padding:"4px 12px"}}>LOGOUT</button>}
            />

            <div style={{flex:1,overflow:"auto",padding:"24px 20px"}}>
              {/* Identity card */}
              <div style={{background:"#0c0c18",border:"1px solid #1a1a30",borderRadius:12,
                padding:"20px 24px",maxWidth:600,margin:"0 auto 32px"}}>
                <div style={{display:"flex",gap:16,alignItems:"flex-start"}}>
                  <Sigil seed={account.avatarSeed||hSeed(address)} size={64}/>
                  <div style={{flex:1,minWidth:0}}>
                    {!editingProfile ? (<>
                      <div style={{fontSize:18,color:"#ddd",fontWeight:600,marginBottom:4}}>{account.name}</div>
                      {account.tags?.length > 0 && (
                        <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:8}}>
                          {account.tags.map((t,i)=>(
                            <span key={i} style={{background:"#12122a",border:"1px solid #1e1e3a",
                              borderRadius:3,padding:"1px 8px",fontSize:10,color:"#7777aa"}}>{t}</span>
                          ))}
                        </div>
                      )}
                      <button onClick={()=>{setEditName(account.name);setEditTags(account.tags?.join(", ")||"");
                        setEditingProfile(true)}} style={{...sGhost,fontSize:9,padding:"2px 10px"}}>EDIT PROFILE</button>
                    </>) : (
                      <div style={{display:"flex",flexDirection:"column",gap:8}}>
                        <input value={editName} onChange={e=>setEditName(e.target.value)}
                          placeholder="name" style={{...sInput,fontSize:13}}/>
                        <input value={editTags} onChange={e=>setEditTags(e.target.value)}
                          placeholder="tags" style={{...sInput,fontSize:11}}/>
                        <div style={{display:"flex",gap:6}}>
                          <button onClick={handleUpdateProfile}
                            style={{...sGhost,fontSize:9,padding:"3px 10px",color:"#30D158",borderColor:"#30D15844"}}>SAVE</button>
                          <button onClick={()=>setEditingProfile(false)}
                            style={{...sGhost,fontSize:9,padding:"3px 10px"}}>CANCEL</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Address + key */}
                <div style={{marginTop:16,paddingTop:16,borderTop:"1px solid #1a1a30"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                    <div style={{fontSize:9,color:"#444",letterSpacing:2}}>SHARD ADDRESS</div>
                    <CopyBtn text={address}/>
                  </div>
                  <div style={{fontSize:11,color:"#3FA9F5",wordBreak:"break-all",
                    fontFamily:"'Brandon Grotesque','JetBrains Mono',sans-serif",lineHeight:1.5,
                    background:"#0a0a12",padding:"6px 8px",borderRadius:4}}>{address}</div>

                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:12,marginBottom:6}}>
                    <div style={{fontSize:9,color:"#444",letterSpacing:2}}>PRIVATE KEY</div>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>setShowPrivKey(!showPrivKey)}
                        style={{...sGhost,fontSize:9,padding:"2px 8px"}}>{showPrivKey?"HIDE":"REVEAL"}</button>
                      {showPrivKey && <CopyBtn text={privKey}/>}
                    </div>
                  </div>
                  {showPrivKey ? (
                    <div style={{fontSize:9,color:"#FF453A",wordBreak:"break-all",
                      fontFamily:"'Brandon Grotesque','JetBrains Mono',sans-serif",lineHeight:1.4,
                      background:"#0a0a12",padding:"6px 8px",borderRadius:4,border:"1px solid #FF453A22"}}>{privKey}</div>
                  ) : (
                    <div style={{fontSize:10,color:"#222",background:"#0a0a12",padding:"6px 8px",
                      borderRadius:4,letterSpacing:4}}>{"•".repeat(32)}</div>
                  )}
                  <div style={{fontSize:8,color:"#FF453A44",marginTop:4}}>
                    Save this key. It is your only way to recover this identity.
                  </div>
                </div>

                <div style={{marginTop:12,display:"flex",gap:16,fontSize:9,color:"#333"}}>
                  <span>created {new Date(account.createdAt).toLocaleDateString()}</span>
                  <span>{contacts.length} contact{contacts.length !== 1 ? "s" : ""} on shard</span>
                </div>
              </div>

              {/* Game grid — now with START buttons */}
              <div style={{maxWidth:600,margin:"0 auto"}}>
                <div style={{fontSize:10,color:"#444",letterSpacing:3,marginBottom:16,textAlign:"center"}}>
                  START A GAME
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  {GAMES.map((g,idx) => (
                    <div key={g.id} style={{
                      background:"#0c0c18",border:`1px solid ${g.accent}22`,borderRadius:10,
                      padding:"16px 14px",transition:"all .25s",
                      animation:`slideIn .4s ${idx*.08}s ease-out both`,
                    }}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor=g.accent+"66";
                      e.currentTarget.style.boxShadow=`0 0 16px ${g.accent}22`}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor=g.accent+"22";
                      e.currentTarget.style.boxShadow="none"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                        <GIcon icon={g.icon} size={24} color={g.accent}/>
                        <span style={{fontSize:14,fontWeight:600,color:g.accent,letterSpacing:1}}>{g.name}</span>
                      </div>
                      <div style={{fontSize:9,color:"#555",letterSpacing:1,marginBottom:4}}>{g.tag.toUpperCase()}</div>
                      <div style={{fontSize:10,color:"#444",lineHeight:1.5,marginBottom:10}}>{g.desc}</div>
                      <button onClick={()=>startGameSession(g)}
                        style={{...sGhost,fontSize:10,padding:"5px 14px",color:g.accent,
                          borderColor:g.accent+"44",width:"100%"}}>
                        START &amp; INVITE
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Existing contacts quick-view */}
              {contacts.length > 0 && (
                <div style={{maxWidth:600,margin:"24px auto 0"}}>
                  <div style={{fontSize:9,color:"#333",letterSpacing:2,marginBottom:8,textAlign:"center"}}>
                    YOUR NETWORK ({contacts.length})
                  </div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center"}}>
                    {contacts.slice(0,20).map(c=>(
                      <div key={c.id} style={{display:"flex",alignItems:"center",gap:4,
                        background:"#0c0c18",border:"1px solid #1a1a30",borderRadius:4,padding:"3px 8px"}}>
                        <span style={{fontSize:12,color:channelColor(c.channel)}}>{channelLabel(c.channel)}</span>
                        <span style={{fontSize:10,color:"#666"}}>{c.name}</span>
                      </div>
                    ))}
                    {contacts.length > 20 && (
                      <span style={{fontSize:10,color:"#333"}}>+{contacts.length-20} more</span>
                    )}
                  </div>
                </div>
              )}

              {/* Danger zone */}
              <div style={{maxWidth:600,margin:"40px auto 20px",textAlign:"center",
                paddingTop:20,borderTop:"1px solid #1a1a2a"}}>
                <button onClick={handleDelete}
                  style={{...sGhost,fontSize:9,color:"#FF453A44",borderColor:"#FF453A22"}}
                  onMouseEnter={e=>{e.currentTarget.style.color="#FF453A";e.currentTarget.style.borderColor="#FF453A66"}}
                  onMouseLeave={e=>{e.currentTarget.style.color="#FF453A44";e.currentTarget.style.borderColor="#FF453A22"}}>
                  DELETE IDENTITY
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── IMPORT CONTACTS ──────────────────────────────── */}
        {phase === "importContacts" && selectedGame && (
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",animation:"fadeIn .4s ease-out"}}>
            <BrandHeader
              subtitle={`${selectedGame.name} — SESSION ${sessionId?.slice(0,12)} — IMPORT CONTACTS`}
              right={<button onClick={()=>setPhase("dashboard")} style={{...sGhost,fontSize:10,padding:"4px 12px"}}>CANCEL</button>}
            />

            <div style={{flex:1,overflow:"auto",padding:"24px 20px"}}>
              <div style={{maxWidth:520,margin:"0 auto"}}>
                {/* Source selector */}
                <div style={{fontSize:10,color:"#555",letterSpacing:2,marginBottom:12,textAlign:"center"}}>
                  ADD CONTACTS FROM
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:8,marginBottom:20}}>
                  {SOURCES.map(s=>(
                    <button key={s.id} onClick={()=>{setImportSource(s.id);setImportDraft("");setCsvDraft("")}}
                      style={{
                        background:importSource===s.id?"#12122a":"#0c0c18",
                        border:`1px solid ${importSource===s.id?s.accent+"66":"#1a1a30"}`,
                        borderRadius:8,padding:"10px 12px",cursor:"pointer",textAlign:"left",
                        transition:"all .2s",
                      }}>
                      <div style={{fontSize:16,marginBottom:4}}>{s.icon}</div>
                      <div style={{fontSize:11,color:s.accent,fontWeight:500,fontFamily:"'Brandon Grotesque','JetBrains Mono',sans-serif"}}>
                        {s.name}
                      </div>
                      <div style={{fontSize:9,color:"#444",marginTop:2,fontFamily:"'Brandon Grotesque','JetBrains Mono',sans-serif"}}>
                        {s.desc}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Import form based on source */}
                {importSource && (
                  <div style={{background:"#0c0c18",border:"1px solid #1a1a30",borderRadius:10,
                    padding:"16px",marginBottom:20,animation:"fadeIn .3s ease-out"}}>

                    {importSource === "email" && (
                      <div style={{display:"flex",flexDirection:"column",gap:10}}>
                        <div style={{fontSize:10,color:"#666",marginBottom:4}}>
                          Paste email addresses (one per line, or "Name &lt;email&gt;" format):
                        </div>
                        <textarea value={importDraft} onChange={e=>setImportDraft(e.target.value)}
                          placeholder={"Alice <alice@example.com>\nbob@example.com\nCarol, carol@example.com"}
                          rows={4} style={{...sInput,fontSize:11,resize:"vertical"}}/>
                        <button onClick={()=>importManualContact()} style={{...sGhost,fontSize:10}}>ADD CONTACTS</button>

                        <div style={{borderTop:"1px solid #1a1a30",paddingTop:10,marginTop:4}}>
                          <div style={{fontSize:10,color:"#666",marginBottom:4}}>Or paste CSV (name,email):</div>
                          <textarea value={csvDraft} onChange={e=>setCsvDraft(e.target.value)}
                            placeholder={"Alice,alice@example.com\nBob,bob@example.com"}
                            rows={3} style={{...sInput,fontSize:10,resize:"vertical"}}/>
                          <button onClick={importCsv} style={{...sGhost,fontSize:10,marginTop:6}}>IMPORT CSV</button>
                        </div>
                      </div>
                    )}

                    {(importSource === "twitter" || importSource === "discord" || importSource === "telegram") && (
                      <div style={{display:"flex",flexDirection:"column",gap:10}}>
                        <div style={{fontSize:10,color:"#666"}}>
                          Add {SOURCES.find(s=>s.id===importSource)?.name} handles (one per line):
                        </div>
                        <textarea value={importDraft} onChange={e=>setImportDraft(e.target.value)}
                          placeholder={importSource==="twitter"?"@alice\nBob, @bob_builds":
                            importSource==="discord"?"alice#1234\nBob, bob_builds":
                            "@alice\nBob, @bob_builds"}
                          rows={4} style={{...sInput,fontSize:11,resize:"vertical"}}/>
                        <button onClick={()=>importManualContact()} style={{...sGhost,fontSize:10}}>ADD CONTACTS</button>
                      </div>
                    )}

                    {importSource === "manual" && (
                      <div style={{display:"flex",flexDirection:"column",gap:10}}>
                        <div style={{fontSize:10,color:"#666"}}>
                          Add contacts in any format (one per line, "Name, handle"):
                        </div>
                        <textarea value={importDraft} onChange={e=>setImportDraft(e.target.value)}
                          placeholder={"Alice, alice@email.com\nBob, @bob_twitter\nCarol, carol#discord"}
                          rows={4} style={{...sInput,fontSize:11,resize:"vertical"}}/>
                        <button onClick={()=>importManualContact()} style={{...sGhost,fontSize:10}}>ADD CONTACTS</button>
                      </div>
                    )}
                  </div>
                )}

                {/* Current contacts list */}
                {contacts.length > 0 && (
                  <div style={{marginBottom:20}}>
                    <div style={{fontSize:10,color:"#555",letterSpacing:2,marginBottom:8}}>
                      YOUR NETWORK — {contacts.length} CONTACT{contacts.length!==1?"S":""}
                    </div>
                    <div style={{maxHeight:200,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
                      {contacts.map((c,i)=>(
                        <div key={c.id} style={{
                          display:"flex",alignItems:"center",gap:8,padding:"6px 10px",
                          background:"#0a0a14",borderRadius:6,animation:`slideIn .3s ${i*.02}s ease-out both`,
                        }}>
                          <span style={{fontSize:14,color:channelColor(c.channel),width:20,textAlign:"center"}}>
                            {channelLabel(c.channel)}
                          </span>
                          <span style={{fontSize:12,color:"#aaa",flex:1}}>{c.name}</span>
                          <span style={{fontSize:10,color:"#555"}}>{c.handle}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Proceed */}
                <div style={{display:"flex",gap:10,justifyContent:"center"}}>
                  <button onClick={()=>{if(contacts.length>0)setPhase("selectInvites");}}
                    disabled={contacts.length===0}
                    style={{...sPrimary,opacity:contacts.length>0?1:.4,
                      cursor:contacts.length>0?"pointer":"not-allowed"}}>
                    SELECT INVITES →
                  </button>
                  <button onClick={()=>setPhase("selectInvites")}
                    style={{...sGhost,fontSize:11}}>SKIP — PLAY SOLO</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── SELECT INVITES (carousel) ────────────────────── */}
        {phase === "selectInvites" && selectedGame && (
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",animation:"fadeIn .4s ease-out"}}>
            <BrandHeader
              subtitle={`${selectedGame.name} — SELECT WHO TO INVITE`}
              right={<div style={{display:"flex",gap:8}}>
                <button onClick={()=>setPhase("importContacts")} style={{...sGhost,fontSize:10,padding:"4px 12px"}}>← BACK</button>
                <button onClick={()=>setPhase("dashboard")} style={{...sGhost,fontSize:10,padding:"4px 12px"}}>CANCEL</button>
              </div>}
            />

            <div style={{flex:1,overflow:"auto",padding:"24px 20px"}}>
              <div style={{maxWidth:520,margin:"0 auto"}}>

                {contacts.length === 0 ? (
                  <div style={{textAlign:"center",color:"#444",fontSize:12,marginTop:40}}>
                    No contacts yet. You can still start the game solo.
                  </div>
                ) : (<>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                    <div style={{fontSize:10,color:"#555",letterSpacing:2}}>
                      {selectedInvites.size} OF {contacts.length} SELECTED
                    </div>
                    <button onClick={toggleAll} style={{...sGhost,fontSize:9,padding:"3px 10px"}}>
                      {selectedInvites.size===contacts.length?"DESELECT ALL":"SELECT ALL"}
                    </button>
                  </div>

                  {/* Horizontal carousel */}
                  <div style={{overflowX:"auto",paddingBottom:12,marginBottom:20}}>
                    <div style={{display:"flex",gap:10,minWidth:"max-content"}}>
                      {contacts.map(c => {
                        const sel = selectedInvites.has(c.id);
                        return (
                          <div key={c.id} onClick={()=>toggleInvite(c.id)}
                            style={{
                              width:110,flexShrink:0,padding:"12px 10px",
                              background:sel?"#12122a":"#0c0c18",
                              border:`1px solid ${sel?channelColor(c.channel)+"88":"#1a1a30"}`,
                              borderRadius:10,cursor:"pointer",textAlign:"center",
                              transition:"all .2s",
                              boxShadow:sel?`0 0 12px ${channelColor(c.channel)}22`:"none",
                            }}>
                            <div style={{fontSize:20,marginBottom:4,
                              filter:sel?"none":"grayscale(1) opacity(0.4)",transition:"filter .2s"}}>
                              {channelLabel(c.channel)}
                            </div>
                            <div style={{fontSize:11,color:sel?"#ddd":"#666",fontWeight:sel?600:400,
                              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                              {c.name}
                            </div>
                            <div style={{fontSize:9,color:"#444",marginTop:2,
                              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                              {c.handle}
                            </div>
                            <div style={{marginTop:6,width:16,height:16,borderRadius:4,margin:"6px auto 0",
                              border:`2px solid ${sel?channelColor(c.channel):"#333"}`,
                              background:sel?channelColor(c.channel):"transparent",
                              display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s"}}>
                              {sel && <span style={{color:"#fff",fontSize:10,lineHeight:1}}>✓</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>)}

                <div style={{display:"flex",gap:10,justifyContent:"center"}}>
                  {selectedInvites.size > 0 && (
                    <button onClick={sendInvites}
                      style={{...sPrimary}}>
                      SEND {selectedInvites.size} INVITE{selectedInvites.size!==1?"S":""} →
                    </button>
                  )}
                  <button onClick={()=>{setPhase("lobby")}}
                    style={sGhost}>
                    {selectedInvites.size > 0 ? "SKIP — ENTER GAME" : "ENTER GAME SOLO"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── SEND INVITES (dispatch) ──────────────────────── */}
        {phase === "sendInvites" && selectedGame && (
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",animation:"fadeIn .4s ease-out"}}>
            <BrandHeader
              subtitle={`${selectedGame.name} — ${invitesSent.length} INVITATION${invitesSent.length!==1?"S":""} ON SHARD`}
              right={<button onClick={()=>setPhase("lobby")} style={{...sGhost,fontSize:10,padding:"4px 12px"}}>ENTER GAME →</button>}
            />

            <div style={{flex:1,overflow:"auto",padding:"24px 20px"}}>
              <div style={{maxWidth:520,margin:"0 auto"}}>
                <div style={{fontSize:10,color:"#555",letterSpacing:2,marginBottom:16,textAlign:"center"}}>
                  DISPATCH INVITATIONS
                </div>

                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {invitesSent.map((inv,i) => {
                    const msg = buildInviteMsg(inv.contact, selectedGame);
                    const url = getDispatchUrl(inv.contact, msg);
                    return (
                      <div key={inv.id} style={{
                        background:"#0c0c18",border:"1px solid #1a1a30",borderRadius:10,
                        padding:"14px",animation:`slideIn .3s ${i*.05}s ease-out both`,
                      }}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                          <span style={{fontSize:16,color:channelColor(inv.channel)}}>
                            {channelLabel(inv.channel)}
                          </span>
                          <span style={{fontSize:12,color:"#ccc",fontWeight:500}}>{inv.contactName}</span>
                          <span style={{fontSize:10,color:"#555"}}>{inv.contactHandle}</span>
                          <div style={{marginLeft:"auto",fontSize:9,color:"#30D158",
                            display:"flex",alignItems:"center",gap:4}}>
                            <div style={{width:5,height:5,borderRadius:"50%",background:"#30D158"}}/>
                            ON SHARD
                          </div>
                        </div>

                        <div style={{background:"#0a0a12",borderRadius:6,padding:"8px 10px",
                          fontSize:10,color:"#666",lineHeight:1.5,whiteSpace:"pre-wrap",
                          marginBottom:8,maxHeight:80,overflow:"auto"}}>
                          {msg}
                        </div>

                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          {url && (
                            <a href={url} target="_blank" rel="noopener noreferrer"
                              style={{...sGhost,fontSize:9,padding:"3px 10px",textDecoration:"none",
                                color:channelColor(inv.channel),borderColor:channelColor(inv.channel)+"44",
                                display:"inline-flex",alignItems:"center",gap:4}}>
                              {inv.channel === "email" ? "OPEN EMAIL CLIENT" :
                               inv.channel === "twitter" ? "OPEN X DM" :
                               inv.channel === "telegram" ? "OPEN TELEGRAM" : "SEND"}
                            </a>
                          )}
                          <CopyBtn text={msg} label="COPY MESSAGE"/>
                          <CopyBtn text={`f1r3.games/join/${sessionId}`} label="COPY LINK"/>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{textAlign:"center",marginTop:24}}>
                  <button onClick={()=>setPhase("lobby")} style={sPrimary}>
                    ENTER GAME →
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── LOBBY (game ready) ───────────────────────────── */}
        {phase === "lobby" && selectedGame && (
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",
            justifyContent:"center",padding:"40px 20px",animation:"fadeIn .5s ease-out"}}>
            <F1R3FLYLogo size={48} />
            <div style={{marginTop:12}}><GIcon icon={selectedGame.icon} size={36} color={selectedGame.accent}/></div>
            <div style={{fontSize:24,fontWeight:600,color:selectedGame.accent,letterSpacing:2,marginTop:16}}>
              {selectedGame.name}
            </div>
            <div style={{fontSize:10,color:"#555",letterSpacing:2,marginTop:4}}>{selectedGame.tag.toUpperCase()}</div>

            <div style={{marginTop:24,background:"#0c0c18",border:`1px solid ${selectedGame.accent}22`,
              borderRadius:10,padding:"16px 20px",textAlign:"center",maxWidth:400,width:"100%"}}>
              <div style={{fontSize:9,color:"#444",letterSpacing:2,marginBottom:8}}>SESSION</div>
              <div style={{fontSize:12,color:"#3FA9F5",wordBreak:"break-all",marginBottom:8}}>{sessionId}</div>
              <div style={{display:"flex",gap:8,justifyContent:"center"}}>
                <CopyBtn text={sessionId} label="COPY ID"/>
                <CopyBtn text={`f1r3.games/join/${sessionId}`} label="COPY LINK"/>
              </div>
              {invitesSent.length > 0 && (
                <div style={{marginTop:12,fontSize:10,color:"#555"}}>
                  {invitesSent.length} invitation{invitesSent.length!==1?"s":""} sent
                </div>
              )}
            </div>

            <div style={{marginTop:24,fontSize:11,color:"#444",textAlign:"center",lineHeight:1.6,maxWidth:360}}>
              The game session and all invitations are stored on the shard.
              When invited players join, they'll connect to this session automatically.
            </div>

            <div style={{display:"flex",gap:12,marginTop:28}}>
              <button onClick={()=>setPhase("dashboard")} style={sGhost}>← BACK TO GAMES</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
