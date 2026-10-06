// Typed values: the wire form the service and the Rust wallet use.
// null, booleans, integers, strings and arrays (lists) are themselves;
// {"bytes": hex}, {"uri": s}, {"tuple": [..]}, {"set": [..]}, {"map": {..}}
// are tagged. These helpers build them, and `plain` reads them back.

export type Typed =
  | null
  | boolean
  | number
  | string
  | Typed[]
  | { bytes: string }
  | { uri: string }
  | { tuple: Typed[] }
  | { set: Typed[] }
  | { map: { [k: string]: Typed } }
  | { unforgeable: string }
  | { opaque: string };

export const T = {
  str: (s: string): Typed => s,
  int: (n: number): Typed => {
    if (!Number.isSafeInteger(n)) throw new Error(`not an integer: ${n}`);
    return n;
  },
  bool: (b: boolean): Typed => b,
  nil: null as Typed,
  bytes: (hex: string): Typed => ({ bytes: hex }),
  list: (xs: Typed[]): Typed => xs,
  set: (xs: Typed[]): Typed => ({ set: xs }),
  tuple: (xs: Typed[]): Typed => ({ tuple: xs }),
  map: (o: { [k: string]: Typed }): Typed => ({ map: o }),
};

export type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };

/** Typed → plain JSON: maps become objects, sets/tuples/lists arrays, bytes hex strings. */
export function plain(v: Typed | undefined): Plain {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(plain);
  if ("map" in v) {
    const o: { [k: string]: Plain } = {};
    for (const [k, x] of Object.entries(v.map)) o[k] = plain(x);
    return o;
  }
  if ("set" in v) return v.set.map(plain);
  if ("tuple" in v) return v.tuple.map(plain);
  if ("bytes" in v) return v.bytes;
  if ("uri" in v) return v.uri;
  if ("unforgeable" in v) return v.unforgeable;
  return v.opaque;
}

/** Plain JSON → typed, for manifests and records written from forms. */
export function typed(v: Plain): Typed {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(typed);
  const o: { [k: string]: Typed } = {};
  for (const [k, x] of Object.entries(v)) o[k] = typed(x);
  return { map: o };
}

export function hexOfText(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function textOfHex(h: string): string {
  const b = new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
  return new TextDecoder().decode(b);
}
