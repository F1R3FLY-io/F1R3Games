/* tslint:disable */
/* eslint-disable */

export function activeAddress(): string;

export function activePublicKey(): string;

/**
 * `[{game, instance, budget, spent, expiresAt}]`.
 */
export function allowances(): string;

export function contactsDecrypt(cipher_hex: string): string;

export function contactsEncrypt(book_json: string): string;

/**
 * Import CSV (`name,kind,handle`) or vCard text into a book: returns
 * `{book, rejected}`.
 */
export function contactsImport(book_json: string, format: string, text: string, now_ms: number): string;

/**
 * Create another key; returns `{address, keyFile}`.
 */
export function createKey(label: string): string;

/**
 * Create a keystore protected by `passphrase`, with a first key. Returns
 * `{keystore, address, keyFile}`; the shell offers `keyFile` for download.
 */
export function createKeystore(passphrase: string, iterations: number, shard_id: string, env_uri: string, fee_cap: number): string;

/**
 * Enrol a passkey, proving knowledge of the passphrase.
 */
export function enrolPasskey(passphrase: string, credential_id: string, prf_output_hex: string): void;

/**
 * Export the key file (re-authenticating with the passphrase).
 */
export function exportKeyFile(passphrase: string, address: string): string;

/**
 * Grant an allowance for a game instance.
 */
export function grantAllowance(game: string, instance: string, templates_json: string, budget: number, expires_at_ms: number): void;

export function importKeyFile(text: string, label: string): string;

/**
 * Create a keystore around an existing key file (import path).
 */
export function importKeystore(passphrase: string, iterations: number, key_file: string, shard_id: string, env_uri: string, fee_cap: number): string;

/**
 * The instance an invitation link names, without the wallet.
 */
export function invitationInstance(link: string): string;

export function isAddress(s: string): boolean;

export function isUnlocked(): boolean;

export function keystoreJson(): string;

/**
 * `[{address, label, active}]` as JSON.
 */
export function listKeys(): string;

export function lock(): void;

export function newInvitation(base_url: string, instance_id: string): string;

/**
 * A fresh invitation key and its link: `{publicKey, link}`.
 * Open an envelope (hex) addressed to the active key. The host passes the
 * hosted game's id and instance (F1R3Pix design R3). A message (version 1)
 * answers {sender, text}; a sealed ink (version 2, F1R3Ink design §7) answers
 * {kind: "ink", target, sid, seq, colour, key}, trying each unlabelled wrap.
 */
export function openEnvelope(game: string, instance: string, envelope_hex: string): string;

/**
 * Open a stored keystore (locked).
 */
export function openKeystore(keystore_json: string, shard_id: string, env_uri: string, fee_cap: number): void;

export function passkeys(): string[];

/**
 * Parse an invitation link and sign its redemption for the active address:
 * `{instanceId, invitePublicKey, signature, fundedKeyFile?}`.
 */
export function redeemInvitation(link: string): string;

/**
 * Register a game's template, as listed (by hash) in its on-chain manifest.
 */
export function registerGameTemplate(game: string, id: string, source: string, expected_hash: string): void;

/**
 * Review a request. Returns `{kind: "prompt"|"within", template, maxFee,
 * summary?, remainingAfter?}`; throws if the policy refuses it.
 */
export function review(origin: string, template: string, args_json: string, prepared_hex: string, instance: string | null | undefined, now_ms: number): string;

export function setActive(address: string): void;

/**
 * Sign after review; `approved` is the person's answer to any prompt.
 * Returns `{deployer, signature}` (hex).
 */
export function sign(origin: string, template: string, args_json: string, prepared_hex: string, instance: string | null | undefined, approved: boolean, now_ms: number): string;

/**
 * Sign a relay request (F1R3Ink design §8): the host composes `message`
 * (JSON naming the hosted game, instance and relay URL). Returns
 * {publicKey, signature} (hex).
 */
export function signRelay(message: string): string;

export function unlockWithPasskey(credential_id: string, prf_output_hex: string): void;

export function unlockWithPassphrase(passphrase: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly activeAddress: () => [number, number, number, number];
    readonly activePublicKey: () => [number, number, number, number];
    readonly allowances: () => [number, number, number, number];
    readonly contactsDecrypt: (a: number, b: number) => [number, number, number, number];
    readonly contactsEncrypt: (a: number, b: number) => [number, number, number, number];
    readonly contactsImport: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly createKey: (a: number, b: number) => [number, number, number, number];
    readonly createKeystore: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly enrolPasskey: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly exportKeyFile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly grantAllowance: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly importKeyFile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly importKeystore: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly invitationInstance: (a: number, b: number) => [number, number, number, number];
    readonly isAddress: (a: number, b: number) => number;
    readonly isUnlocked: () => number;
    readonly keystoreJson: () => [number, number, number, number];
    readonly listKeys: () => [number, number, number, number];
    readonly lock: () => [number, number];
    readonly newInvitation: (a: number, b: number, c: number, d: number) => [number, number];
    readonly openEnvelope: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly openKeystore: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly passkeys: () => [number, number, number, number];
    readonly redeemInvitation: (a: number, b: number) => [number, number, number, number];
    readonly registerGameTemplate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly review: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number, number];
    readonly setActive: (a: number, b: number) => [number, number];
    readonly sign: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly signRelay: (a: number, b: number) => [number, number, number, number];
    readonly unlockWithPasskey: (a: number, b: number, c: number, d: number) => [number, number];
    readonly unlockWithPassphrase: (a: number, b: number) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
