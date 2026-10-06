# From the React shell to f1r3lang in F1R3Gaze

The web shell is built so that it can serve as the test bed for doing the same
thing in F1R3Gaze, where a page's behaviour is f1r3lang on a native RSpace and
pages hold capabilities rather than ambient authority. This note says how the
shell is cut to make that possible, what each piece maps to in F1R3Gaze
(as of `f6ee26a`), what F1R3Gaze lacks, and how to use the shell's tests to
drive that work.

## 1. How the shell is cut

`web/src/core/` is framework-free TypeScript. It holds every operation the
portal performs (`portal.ts`), and it reaches the outside world only through
eight capabilities (`capabilities.ts`). `web/src/ui/` is React and only
renders: it calls `Portal` methods and shows the results. Nothing in `ui/`
touches the network, the wallet or storage directly.

Every capability answers in the F1R3Gaze convention —
`("ok", value)` or `("err", code, message)` (`core/result.ts`) — and the game
protocol carries exactly those tuples (`core/host.ts`). So a `Portal` method
translates line by line into a f1r3lang process that sends to the same
capabilities and matches the same answers.

## 2. Capability map

| Capability | Methods the shell uses | Web implementation | In F1R3Gaze today | Needed |
|---|---|---|---|---|
| `doc` | render, navigate | React DOM | `doc` (present) | — |
| `shard` (read) | explore a catalogue template, typed result + block hash | `HttpService.explore` → service → observer | the shard bridge speaks `/api/explore-deploy` | a page-facing read capability that renders **catalogue** templates only, so a page cannot run arbitrary terms under the user's identity |
| `shard` (write) | prepare → sign → send | `Portal.call` (service renders, wallet re-renders and compares) | the browser renders every deploy itself and binds only allow-listed system names | none for the call templates themselves: they bind only `rho:registry:lookup` and `rho:system:deployId`. Update the allow-list from `rho:rchain:deployId` / `rho:rev:address` to `master`'s `rho:system:deployId` / `rho:vault:address` |
| `wallet` | address, sign with consent, key create/import/export | Rust wallet in WASM (`crates/wallet`) | wallets in F1R3Sky file format, consent prompt quoting phlo | allowances (sign a game's play templates within a budget and expiry without prompting): `wallet!("grant", game, instance, templates, budget, expiry, *ret)` |
| `consent` | ask(summary, cost) | `ConsentDialog` | the chrome's consent prompt | the **payment** flag below |
| `invite` | new invitation key + link; sign redemption for the active address | `newInvitation`, `redeemInvitation` in the WASM wallet | none | a capability that mints a one-use secp256k1 key and signs `f1r3games:redeem:v1:…` with it; private key never enters page memory |
| `store` | keystore, contacts ciphertext, settings | IndexedDB | profile directory (wallets in OS keychain) | per-site persistent storage for pages |
| `contacts` | import CSV/vCard, encrypt/decrypt book, backup ciphertext | WASM wallet + `store` | none | a contacts capability (book encrypted under a key derived from the wallet key; HKDF info `f1r3games/contacts/v1`, same bytes as the web wallet so a backup opens in either) |
| `passkey` | WebAuthn PRF output to unwrap the keystore | `core/passkey.ts` | keys in the OS keychain already | nothing new for unlock: OS keychain + biometrics plays this role |
| `share` | deliver an invitation link | Web Share / `mailto:` / clipboard | none | `share` capability (OS share sheet) |
| `pay` | pay participants of the hosted instance | `GameHost` `pay` → `Portal.pay` → `payments.send` (prompted, portal origin only) | none | the `pay` capability of §3, attenuated to the instance's participants; `payments.send` is the first method declared to go through it |
| `open` | open a message envelope sealed to the active key | `Wallet.openEnvelope` (Rust `envelope::open`), game and instance bound by the host | none | a wallet operation doing ECDH with the identity key under a caller-fixed `info` string (`<game>/msg/v1` ‖ instance), never yielding the key |
| `frame` | host a game, answer its protocol | sandboxed iframe + `GameHost` | none (no page-to-page capabilities) | hand a game page an attenuated `portal` capability: `deploy` (its own templates, within allowance), `read`, `publishPlay`, `invite`, `engage` — the five methods of `core/host.ts`, now as a name instead of `postMessage` |

## 3. The first thing to settle in F1R3Gaze: authority reached through installed contracts

F1R3Gaze's safety rule is that the browser refuses any deploy that binds
deployer authority (`rho:rchain:deployerId`). The portal's call templates pass
that rule — yet some of them move the caller's funds. `sponsors.create` and
`sponsors.fund` call into the `games` environment, and the **environment's**
code obtains the caller's vault authority from `rho:deploy:data` and transfers.
A term-level allow-list cannot see this; it is a property of the installed
contract being called.

The F1R3Games wallet handles it by knowing its methods: it pins the
environment URI, recognises each call against its catalogue, and announces
fund-moving methods as payments (`catalogue::MOVES_FUNDS`; the consent text
begins `PAYMENT of … from your vault`). F1R3Gaze needs an equivalent before
f1r3lang pages call such contracts:

1. a registry of trusted installed contracts (URI + version) and of which of
   their methods exercise deployer authority, or
2. the `pay` capability listed under "Not in this release", through which a
   page must route any call that exercises deployer authority, with the
   contract's methods declaring this.

This is a finding about the Gaze safety model, surfaced by building the portal.

## 4. One operation, both ways

`Portal.launch` in TypeScript:

```ts
const p = await service.prepare({ template: "instances.create", args: { game, visibility, config }, deployer, derive: ["id"] });
// check p.args, wallet.review, consent.ask, wallet.sign, service.send
```

The same operation as a f1r3lang page holding `shard`, `wallet` and `doc`:

```rholang
new prep, sig, sent, nav in {
  shard!("prepare", "instances.create",
         {"game": "f1r3pix", "visibility": "unlisted", "config": {}}, ["id"], *prep) |
  for (@("ok", p) <- prep) {
    wallet!("sign", "portal", p, *sig) |                 // review + consent inside the wallet
    for (@("ok", s) <- sig) {
      shard!("send", p, s, *sent) |
      for (@("ok", _) <- sent) {
        doc!("navigate", "/instances/" ++ p.get("derived").get("id"), *nav)
      }
    }
  } |
  for (@("err", code, message) <- prep) { doc!("toast", message, *nav) }
}
```

In F1R3Gaze the `prepare` step can collapse into the browser: it already
renders deploys itself, so `shard!("call", "instances.create", args, *ret)`
could render the catalogue template locally and skip the service. The service
remains useful for reads, faucet and, for the web, rendering; the wallet's
re-render-and-compare check makes either path safe.

## 5. Using the shell's tests to drive the Gaze work

* `web/src/test/core.test.ts` is the executable specification of the portal's
  behaviour: sign-on, profile, launch (unlisted), consent refusal, refusal of a
  service that alters arguments, invite and redeem by a second identity,
  galleries, contacts (local and backup), and hosting a game within an
  allowance without a prompt.
* `crates/service/examples/testbed.rs` runs the real service in front of a mock
  node that verifies every deploy signature and records it. F1R3Gaze can point
  at the same testbed (`settings.conf`: validator/observer = the mock), and
  `f1r3gaze --headless URL --click …` can replay each test as a page script,
  asserting on the testbed's `/__mock/deploys`. The expected deploy terms are
  identical, because both sides render the same catalogue templates.
* The key file, invitation signatures and contact-backup ciphertext are
  byte-compatible across the web wallet and anything implementing the formats
  in `crates/core` and `crates/wallet`; a test can create an identity in one
  and use it in the other.

## 6. Suggested order for F1R3Gaze

1. Allow-list names updated to `master`; catalogue call templates accepted as page deploys.
2. Page-facing `shard` read capability over catalogue explore templates.
3. Trusted-contract registry or `pay` (§3) — before any fund-moving call.
4. `invite` and `contacts` capabilities (formats from `crates/core`, `crates/wallet`).
5. Allowances in the Gaze wallet.
6. Page-to-page `portal` capability for games (replacing `postMessage`).
7. `store`, `share`.
