import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Portal, type Consent, type ConsentRequest } from "../core/portal";
import type { Service } from "../core/service";
import { IndexedDbStore, type Store } from "../core/store";
import type { WalletWasm } from "../core/wallet";

interface Ctx {
  portal: Portal | null;
  error: string | null;
  /** Bumped whenever sign-on state changes, so views re-read. */
  epoch: number;
  refresh(): void;
  consentRequest: ConsentRequest | null;
  answerConsent(ok: boolean): void;
}

const PortalCtx = createContext<Ctx | null>(null);

export function PortalProvider(props: { children: ReactNode; loadWasm: () => Promise<WalletWasm>; service?: Service; store?: Store; iterations?: number }) {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [consentRequest, setConsentRequest] = useState<ConsentRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const consent: Consent = useMemo(
    () => ({
      ask: (r) =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setConsentRequest(r);
        }),
    }),
    [],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const wasm = await props.loadWasm();
        const p = await Portal.boot({ wasm, store: props.store ?? new IndexedDbStore(), consent, service: props.service, iterations: props.iterations });
        if (live) setPortal(p);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const answerConsent = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setConsentRequest(null);
  }, []);

  const value = { portal, error, epoch, refresh: () => setEpoch((e) => e + 1), consentRequest, answerConsent };
  return <PortalCtx.Provider value={value}>{props.children}</PortalCtx.Provider>;
}

export function usePortalCtx() {
  const c = useContext(PortalCtx);
  if (!c) throw new Error("PortalProvider missing");
  return c;
}

export function usePortal(): Portal {
  const c = usePortalCtx();
  if (!c.portal) throw new Error("portal not ready");
  return c.portal;
}

/** Load data with the portal; re-runs when deps or sign-on change. */
export function useLoad<T>(f: (p: Portal) => Promise<T>, deps: unknown[] = []): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const { portal, epoch } = usePortalCtx();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!portal) return;
    let live = true;
    setLoading(true);
    f(portal)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [portal, epoch, n, ...deps]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}
