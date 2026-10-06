// The game side of the host protocol (version 2): a game page includes this
// to talk to the portal that framed it. Every call answers ["ok", value] or
// rejects with {code, message}. `pay` and `open` require the game's manifest
// to declare them in `capabilities` (F1R3Pix design §8).

export const PROTOCOL = 2;

export interface PortalBridge {
  hello(): Promise<{ protocol: number; address: string; publicKey: string; profile: unknown; instance: unknown }>;
  deploy(template: string, args: Record<string, unknown>, phloLimit?: number): Promise<{ deployId: string }>;
  read(template: string, args: Record<string, unknown>, meta?: boolean): Promise<unknown>;
  publishPlay(kind: string, header: Record<string, unknown>, bodyHex: string): Promise<{ playId: string }>;
  linkPlays(id: string, other: string): Promise<unknown>;
  engage(play: string, kind: string): Promise<unknown>;
  invite(): Promise<true>;
  pay(to: string[], amounts: number[], memo?: string | null): Promise<{ deployId: string }>;
  open(envelopeHex: string): Promise<{ sender: string; text: string }>;
  balance(): Promise<unknown>;
  payments(cursor?: Record<string, number>): Promise<unknown[]>;
  profiles(addresses: string[]): Promise<Record<string, unknown>>;
}

export function connect(portalOrigin: string, target: Window = window.parent): PortalBridge {
  let next = 1;
  const waiting = new Map<number, [(v: any) => void, (e: any) => void]>();
  window.addEventListener("message", (e) => {
    if (e.origin !== portalOrigin || !e.data || e.data.f1r3games !== PROTOCOL || !waiting.has(e.data.id)) return;
    const [res, rej] = waiting.get(e.data.id)!;
    waiting.delete(e.data.id);
    const r = e.data.result;
    if (r[0] === "ok") res(r[1]);
    else rej({ code: r[1], message: r[2] });
  });
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>((res, rej) => {
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
  };
}
