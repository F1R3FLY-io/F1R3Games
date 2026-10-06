// The capabilities the portal shell holds — and therefore what a f1r3lang
// rendition in F1R3Gaze must be handed. The shell has no other authority:
// everything it does goes through one of these.
//
//   shard    Service      prepare/send writes, explore reads (F1R3Gaze: shard bridge)
//   wallet   Wallet       keys, review, sign, invitations, contacts crypto (F1R3Gaze: wallet, extended)
//   store    Store        encrypted keystore + contacts, settings (F1R3Gaze: profile storage)
//   consent  Consent      ask the person to approve a signature (F1R3Gaze: chrome prompt)
//   passkey  passkey.ts   WebAuthn PRF (F1R3Gaze: OS passkey API)
//   share    navigator.share / mailto / clipboard (F1R3Gaze: share capability)
//   frame    GameHost     host a game and answer its protocol (F1R3Gaze: page-to-page capability)
//   doc      React DOM    render (F1R3Gaze: `doc`, already present)

export type { Service } from "./service";
export type { Store } from "./store";
export type { Consent } from "./portal";
export { Wallet } from "./wallet";
export { GameHost } from "./host";
