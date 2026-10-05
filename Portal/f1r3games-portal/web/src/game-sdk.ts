// The game side of the host protocol: a game page includes this to talk to
// the portal that framed it. Every call answers ["ok", value] or rejects
// with {code, message}.

export interface PortalBridge {
  hello(): Promise<{ address: string; profile: unknown; instance: unknown }>;
  deploy(template: string, args: Record<string, unknown>, phloLimit?: number): Promise<{ deployId: string }>;
  read(template: string, args: Record<string, unknown>): Promise<unknown>;
  publishPlay(kind: string, header: Record<string, unknown>, bodyHex: string): Promise<{ playId: string }>;
  linkPlays(id: string, other: string): Promise<unknown>;
  engage(play: string, kind: string): Promise<unknown>;
  invite(): Promise<true>;
}

export function connect(portalOrigin: string, target: Window = window.parent): PortalBridge {
  let next = 1;
  const waiting = new Map<number, [(v: any) => void, (e: any) => void]>();
  window.addEventListener("message", (e) => {
    if (e.origin !== portalOrigin || !e.data || e.data.f1r3games !== 1 || !waiting.has(e.data.id)) return;
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
      target.postMessage({ f1r3games: 1, id, method, params }, portalOrigin);
    });
  return {
    hello: () => call("hello"),
    deploy: (template, args, phloLimit) => call("deploy", { template, args, phloLimit }),
    read: (template, args) => call("read", { template, args }),
    publishPlay: (kind, header, body) => call("publishPlay", { kind, header, body }),
    linkPlays: (id, other) => call("linkPlays", { id, other }),
    engage: (play, kind) => call("engage", { play, kind }),
    invite: () => call("invite"),
  };
}
