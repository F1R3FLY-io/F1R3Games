/**
 * F1R3 Key Management
 * ECDSA P-256 keypair generation, address derivation, and signing.
 * The public key hash IS the shard address. The private key IS the credential.
 */

export interface F1R3Keypair {
  privHex: string;
  pubHex: string;
  address: string; // 20-byte hex from SHA-256(spki)
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): ArrayBuffer {
  const bytes = hex.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [];
  return new Uint8Array(bytes).buffer;
}

async function hashBuffer(buf: ArrayBuffer): Promise<string> {
  return bufToHex(await crypto.subtle.digest("SHA-256", buf));
}

/**
 * Generate a new ECDSA P-256 keypair.
 * Returns private key hex, public key hex, and the 20-byte shard address.
 */
export async function generateKeypair(): Promise<F1R3Keypair> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privRaw = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const pubRaw = await crypto.subtle.exportKey("spki", kp.publicKey);
  const privHex = bufToHex(privRaw);
  const pubHex = bufToHex(pubRaw);
  const address = (await hashBuffer(pubRaw)).slice(0, 40);
  return { privHex, pubHex, address };
}

/**
 * Recover shard address from a private key hex string.
 * Derives the public key via JWK round-trip, then hashes SPKI to get address.
 */
export async function recoverAddress(privHex: string): Promise<string | null> {
  try {
    const privKey = await crypto.subtle.importKey(
      "pkcs8", hexToBuf(privHex),
      { name: "ECDSA", namedCurve: "P-256" },
      true, ["sign"]
    );
    const jwk = await crypto.subtle.exportKey("jwk", privKey);
    const pubJwk = { ...jwk, d: undefined, key_ops: ["verify"] };
    delete (pubJwk as any).d;
    const pubKey = await crypto.subtle.importKey(
      "jwk", pubJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true, ["verify"]
    );
    const pubRaw = await crypto.subtle.exportKey("spki", pubKey);
    return (await hashBuffer(pubRaw)).slice(0, 40);
  } catch (e) {
    console.error("Key recovery failed:", e);
    return null;
  }
}

/**
 * Sign a challenge string with the private key.
 * Used for authentication: prove ownership of an address.
 */
export async function signChallenge(privHex: string, challenge: string): Promise<string | null> {
  try {
    const privKey = await crypto.subtle.importKey(
      "pkcs8", hexToBuf(privHex),
      { name: "ECDSA", namedCurve: "P-256" },
      false, ["sign"]
    );
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privKey,
      new TextEncoder().encode(challenge)
    );
    return bufToHex(sig);
  } catch {
    return null;
  }
}

/**
 * Derive a deterministic avatar seed from any string (address, id, etc.)
 */
export function avatarSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
