import type { ReactNode } from "react";

export function Async<T>({ state, children, empty }: { state: { data: T | undefined; error: string | null; loading: boolean }; children: (d: NonNullable<T>) => ReactNode; empty?: ReactNode }) {
  if (state.error) return <p className="error">{state.error}</p>;
  if (state.loading && state.data === undefined) return <p className="muted">Loading…</p>;
  if (state.data === undefined || state.data === null || (Array.isArray(state.data) && state.data.length === 0)) return <>{empty ?? <p className="muted">Nothing here yet.</p>}</>;
  return <>{children(state.data as NonNullable<T>)}</>;
}
