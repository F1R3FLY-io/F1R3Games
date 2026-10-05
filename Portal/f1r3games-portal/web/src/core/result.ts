// The capability convention shared with f1r3lang in F1R3Gaze: every call
// answers ("ok", value) or ("err", code, message). In f1r3lang a page writes
//   wallet!("sign", request, *ret) | for (@("ok", sig) <- ret) { ... }
// and the portal's TypeScript capabilities answer the same shape, so the
// same page logic can be expressed on either side.

export type Ok<T> = readonly ["ok", T];
export type Err = readonly ["err", string, string];
export type Result<T> = Ok<T> | Err;

export const ok = <T>(v: T): Ok<T> => ["ok", v] as const;
export const err = (code: string, message: string): Err => ["err", code, message] as const;

export class CapError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Unwrap a result or throw a CapError. */
export function unwrap<T>(r: Result<T>): T {
  if (r[0] === "ok") return r[1];
  throw new CapError(r[1], r[2]);
}

/** Run an async function, catching into a Result. */
export async function attempt<T>(code: string, f: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await f());
  } catch (e) {
    if (e instanceof CapError) return err(e.code, e.message);
    return err(code, e instanceof Error ? e.message : String(e));
  }
}
