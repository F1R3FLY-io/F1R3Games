// The `wallet` capability: the F1R3Games wallet (Rust, compiled to WASM).
// Keys stay inside the WASM module; JavaScript sees addresses, public keys,
// decisions and signatures. The keystore JSON (encrypted) is persisted
// through the `store` capability after every change.

import type { Store } from "./store";
import type { Typed } from "./values";

/** The functions exported by crates/wallet/src/wasm.rs. */
export interface WalletWasm {
  createKeystore(pass: string, iterations: number, shard: string, env: string, feeCap: number): string;
  importKeystore(pass: string, iterations: number, keyFile: string, shard: string, env: string, feeCap: number): string;
  openKeystore(json: string, shard: string, env: string, feeCap: number): void;
  keystoreJson(): string;
  unlockWithPassphrase(pass: string): void;
  unlockWithPasskey(credentialId: string, prfHex: string): void;
  enrolPasskey(pass: string, credentialId: string, prfHex: string): void;
  passkeys(): string[];
  lock(): void;
  isUnlocked(): boolean;
  listKeys(): string;
  createKey(label: string): string;
  importKeyFile(text: string, label: string): string;
  setActive(address: string): void;
  exportKeyFile(pass: string, address: string): string;
  activeAddress(): string;
  activePublicKey(): string;
  isAddress(s: string): boolean;
  registerGameTemplate(game: string, id: string, source: string, hash: string): void;
  grantAllowance(game: string, instance: string, templatesJson: string, budget: number, expiresAt: number): void;
  allowances(): string;
  review(origin: string, template: string, argsJson: string, preparedHex: string, instance: string | undefined, now: number): string;
  sign(origin: string, template: string, argsJson: string, preparedHex: string, instance: string | undefined, approved: boolean, now: number): string;
  newInvitation(base: string, instance: string): string;
  redeemInvitation(link: string): string;
  invitationInstance(link: string): string;
  contactsEncrypt(bookJson: string): string;
  contactsDecrypt(hex: string): string;
  contactsImport(bookJson: string, format: string, text: string, now: number): string;
}

export type Decision =
  | { kind: "prompt"; template: string; maxFee: number; summary: string }
  | { kind: "within"; template: string; maxFee: number; remainingAfter: number };

export interface KeyInfo {
  address: string;
  label: string;
  active: boolean;
}

export interface SignInput {
  origin: "portal" | string; // "portal" or a game id
  template: string;
  args: { [k: string]: Typed };
  prepared: string;
  instance?: string;
}

const KEYSTORE = "keystore";
const PASSKEY = "passkey";

export class Wallet {
  constructor(
    private w: WalletWasm,
    private store: Store,
    private shardId: string,
    private envUri: string,
    private feeCap = 1_000_000_000,
    public iterations = 600_000,
  ) {}

  async exists(): Promise<boolean> {
    return (await this.store.get(KEYSTORE)) !== null;
  }

  private async persist() {
    await this.store.set(KEYSTORE, this.w.keystoreJson());
  }

  /** Create a keystore and a first key. Returns the key file for download. */
  async create(passphrase: string): Promise<{ address: string; keyFile: string }> {
    const r = JSON.parse(this.w.createKeystore(passphrase, this.iterations, this.shardId, this.envUri, this.feeCap));
    await this.store.set(KEYSTORE, r.keystore);
    return { address: r.address, keyFile: r.keyFile };
  }

  /** Create a keystore around a key file from F1R3Sky, F1R3Gaze or another wallet. */
  async import(passphrase: string, keyFile: string): Promise<string> {
    const r = JSON.parse(this.w.importKeystore(passphrase, this.iterations, keyFile, this.shardId, this.envUri, this.feeCap));
    await this.store.set(KEYSTORE, r.keystore);
    return r.address;
  }

  /** Open the stored keystore (locked). */
  async open(): Promise<boolean> {
    const j = await this.store.get(KEYSTORE);
    if (!j) return false;
    this.w.openKeystore(j, this.shardId, this.envUri, this.feeCap);
    return true;
  }

  unlock(passphrase: string) {
    this.w.unlockWithPassphrase(passphrase);
  }

  async unlockWithPasskey(evaluate: (credentialId: string) => Promise<string>) {
    const id = await this.store.get(PASSKEY);
    if (!id) throw new Error("no passkey is enrolled on this device");
    this.w.unlockWithPasskey(id, await evaluate(id));
  }

  async enrolPasskey(passphrase: string, credentialId: string, prfHex: string) {
    this.w.enrolPasskey(passphrase, credentialId, prfHex);
    await this.store.set(PASSKEY, credentialId);
    await this.persist();
  }

  async hasPasskey() {
    return (await this.store.get(PASSKEY)) !== null;
  }

  lock() {
    this.w.lock();
  }
  get unlocked() {
    return this.w.isUnlocked();
  }
  get address() {
    return this.w.activeAddress();
  }
  get publicKey() {
    return this.w.activePublicKey();
  }
  keys(): KeyInfo[] {
    return JSON.parse(this.w.listKeys());
  }
  async createKey(label: string) {
    const r = JSON.parse(this.w.createKey(label));
    await this.persist();
    return r as { address: string; keyFile: string };
  }
  async importKeyFile(text: string, label: string) {
    const a = this.w.importKeyFile(text, label);
    await this.persist();
    return a;
  }
  async setActive(address: string) {
    this.w.setActive(address);
    await this.persist();
  }
  exportKeyFile(passphrase: string, address = this.address) {
    return this.w.exportKeyFile(passphrase, address);
  }
  isAddress(s: string) {
    return this.w.isAddress(s);
  }

  registerGameTemplate(game: string, id: string, source: string, hash: string) {
    this.w.registerGameTemplate(game, id, source, hash);
  }
  grantAllowance(game: string, instance: string, templates: string[], budget: number, expiresAt: number) {
    this.w.grantAllowance(game, instance, JSON.stringify(templates), budget, expiresAt);
  }

  allowances(): { game: string; instance: string; budget: number; spent: number; expiresAt: number }[] {
    return JSON.parse(this.w.allowances());
  }

  review(s: SignInput, now = Date.now()): Decision {
    return JSON.parse(this.w.review(s.origin, s.template, JSON.stringify(s.args), s.prepared, s.instance, now));
  }
  sign(s: SignInput, approved: boolean, now = Date.now()): { deployer: string; signature: string } {
    return JSON.parse(this.w.sign(s.origin, s.template, JSON.stringify(s.args), s.prepared, s.instance, approved, now));
  }

  newInvitation(base: string, instance: string): { publicKey: string; link: string } {
    return JSON.parse(this.w.newInvitation(base, instance));
  }
  redeemInvitation(link: string): { instanceId: string; invitePublicKey: string; signature: string; fundedKeyFile: string | null } {
    return JSON.parse(this.w.redeemInvitation(link));
  }
  invitationInstance(link: string) {
    return this.w.invitationInstance(link);
  }

  contactsEncrypt(book: ContactBook): string {
    return this.w.contactsEncrypt(JSON.stringify(book));
  }
  contactsDecrypt(hex: string): ContactBook {
    return JSON.parse(this.w.contactsDecrypt(hex));
  }
  contactsImport(book: ContactBook, format: "csv" | "vcard", text: string): { book: ContactBook; rejected: string[] } {
    return JSON.parse(this.w.contactsImport(JSON.stringify(book), format, text, Date.now()));
  }
}

export interface Contact {
  id: string;
  name: string;
  channels: { kind: string; handle: string }[];
  note: string;
  addedAt: number;
}

export interface ContactBook {
  mode: "clientOnly" | "onChainBackup";
  contacts: Contact[];
}
