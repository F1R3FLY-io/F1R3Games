// The game side of the F1R3Games host protocol (version 2). A game page
// framed by the Portal reaches identity, the shard and payment only through
// these messages; it never sees a key. Every call answers ["ok", value] or
// rejects with {code, message}.
//
// Version 2 adds `pay` and `open` (F1R3Pix design §8), and three read-only
// methods the client needs for its left and right columns: `balance`,
// `payments` and `profiles`. `read` may ask for the block it reflects.

export const PROTOCOL = 2;

export function connect(portalOrigin, target = window.parent, self = window) {
  let next = 1;
  const waiting = new Map();
  const listeners = new Set();
  self.addEventListener("message", (e) => {
    if (e.origin !== portalOrigin || !e.data || e.data.f1r3games !== PROTOCOL) return;
    if (e.data.event) { for (const l of listeners) l(e.data.event, e.data.data); return; }
    if (!waiting.has(e.data.id)) return;
    const [res, rej] = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    const r = e.data.result;
    if (r[0] === "ok") res(r[1]);
    else rej({ code: r[1], message: r[2] });
  });
  const call = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = next++;
      waiting.set(id, [res, rej]);
      target.postMessage({ f1r3games: PROTOCOL, id, method, params }, portalOrigin);
    });
  return {
    hello: () => call("hello"),
    deploy: (template, args, phloLimit) => call("deploy", { template, args, phloLimit }),
    read: (template, args, meta = false) => call("read", { template, args, meta }),
    publishPlay: (kind, header, body) => call("publishPlay", { kind, header, body }),
    linkPlays: (id, other) => call("linkPlays", { id, other }),
    engage: (play, kind) => call("engage", { play, kind }),
    invite: () => call("invite"),
    pay: (to, amounts, memo = null) => call("pay", { to, amounts, memo }),
    open: (envelope) => call("open", { envelope }),
    balance: () => call("balance"),
    payments: (cursor = {}) => call("payments", { cursor }),
    profiles: (addresses) => call("profiles", { addresses }),
    on: (f) => { listeners.add(f); return () => listeners.delete(f); },
  };
}

/** The portal origin this frame was given (?portal=…), or null when not framed. */
export function portalOrigin(loc = window.location) {
  const p = new URLSearchParams(loc.search).get("portal");
  try { return p ? new URL(p).origin : null; } catch { return null; }
}

export const instanceParam = (loc = window.location) => new URLSearchParams(loc.search).get("instance");
