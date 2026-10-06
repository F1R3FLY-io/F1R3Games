// Canonical CBOR for the subset the pattern body uses: unsigned integers,
// text, arrays and maps with text keys (sorted by encoded length, then bytes).
const enc = new TextEncoder();

function head(out, major, n) {
  const m = major << 5;
  if (n < 24) out.push(m | n);
  else if (n < 256) out.push(m | 24, n);
  else if (n < 65536) out.push(m | 25, n >> 8, n & 255);
  else if (n < 2 ** 32) out.push(m | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  else throw new RangeError("value too large");
}

function put(out, v) {
  if (Number.isInteger(v) && v >= 0) head(out, 0, v);
  else if (typeof v === "string") { const b = enc.encode(v); head(out, 3, b.length); out.push(...b); }
  else if (Array.isArray(v)) { head(out, 4, v.length); for (const x of v) put(out, x); }
  else if (v && typeof v === "object") {
    const es = Object.entries(v).map(([k, x]) => { const kb = []; put(kb, k); return [kb, x]; });
    es.sort((a, b) => a[0].length - b[0].length || cmp(a[0], b[0]));
    head(out, 5, es.length);
    for (const [kb, x] of es) { out.push(...kb); put(out, x); }
  } else throw new TypeError("unsupported CBOR value");
}
const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

export function encodeCbor(v) { const out = []; put(out, v); return Uint8Array.from(out); }

export function decodeCbor(b) {
  let i = 0;
  const u8 = () => { if (i >= b.length) throw new Error("truncated"); return b[i++]; };
  const arg = (info) => {
    if (info < 24) return info;
    if (info === 24) return u8();
    if (info === 25) return u8() * 256 + u8();
    if (info === 26) return ((u8() * 256 + u8()) * 256 + u8()) * 256 + u8();
    throw new Error("unsupported CBOR length");
  };
  const item = (depth) => {
    if (depth > 16) throw new Error("too deep");
    const h = u8(), n = arg(h & 31);
    switch (h >> 5) {
      case 0: return n;
      case 3: { if (i + n > b.length) throw new Error("truncated"); const s = new TextDecoder().decode(b.slice(i, i + n)); i += n; return s; }
      case 4: return Array.from({ length: n }, () => item(depth + 1));
      case 5: { const o = {}; for (let k = 0; k < n; k++) { const key = item(depth + 1); if (typeof key !== "string") throw new Error("bad key"); o[key] = item(depth + 1); } return o; }
      default: throw new Error("unsupported CBOR type");
    }
  };
  const v = item(0);
  if (i !== b.length) throw new Error("trailing bytes");
  return v;
}
