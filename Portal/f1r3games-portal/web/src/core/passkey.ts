// Passkeys through the WebAuthn PRF extension. The PRF output (32 bytes,
// evaluated with a fixed salt) is what the Rust keystore wraps its data key
// under (HKDF-SHA-256); the passkey itself never leaves the authenticator.
// In F1R3Gaze this is a platform capability (the OS passkey APIs).

const PRF_SALT = new TextEncoder().encode("f1r3games/keystore/prf/v1");

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Register a passkey for this keystore; returns {credentialId, prfHex}. */
export async function registerPasskey(label: string): Promise<{ credentialId: string; prfHex: string }> {
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "F1R3Games" },
      user: { id: userId, name: label, displayName: label },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: PRF_SALT } } } as any,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey creation was cancelled");
  const credentialId = b64u(cred.rawId);
  // Some authenticators return the PRF only on assertion: ask once more.
  return { credentialId, prfHex: await evaluatePasskey(credentialId) };
}

/** Evaluate the PRF of an enrolled passkey. */
export async function evaluatePasskey(credentialId: string): Promise<string> {
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: unb64u(credentialId) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } } as any,
    },
  })) as PublicKeyCredential | null;
  const out = (a?.getClientExtensionResults() as any)?.prf?.results?.first as ArrayBuffer | undefined;
  if (!out) throw new Error("this authenticator does not support the PRF extension");
  return hex(out);
}
