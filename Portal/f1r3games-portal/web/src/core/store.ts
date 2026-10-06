// The `store` capability: small, per-person, persistent key-value storage
// (the encrypted keystore, the encrypted contact book, settings). IndexedDB
// in a web browser; in F1R3Gaze, the profile directory.

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements Store {
  private m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

export class IndexedDbStore implements Store {
  private db: Promise<IDBDatabase>;
  constructor(name = "f1r3games") {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const r = f(db.transaction("kv", mode).objectStore("kv"));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async get(k: string) {
    return ((await this.tx("readonly", (s) => s.get(k))) as string | undefined) ?? null;
  }
  async set(k: string, v: string) {
    await this.tx("readwrite", (s) => s.put(v, k));
  }
  async delete(k: string) {
    await this.tx("readwrite", (s) => s.delete(k));
  }
}
