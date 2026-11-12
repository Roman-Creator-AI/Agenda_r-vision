// Bibliothèque de cours : fichiers + texte extrait + résumé + conversation, stockés dans IndexedDB
// (le localStorage est trop petit). Repli en mémoire si IndexedDB est indisponible (navigation privée).
export const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const DB = 'campass-cours', STORE = 'documents';

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

class MemoryBackend {
  constructor() { this.m = new Map(); this.n = 1; this.persistent = false; }
  async all() { return [...this.m.values()].map(v => structuredClone(v)); }
  async get(id) { const v = this.m.get(id); return v ? structuredClone(v) : undefined; }
  async put(rec) { if (!rec.id) rec.id = this.n++; this.m.set(rec.id, structuredClone(rec)); return rec.id; }
  async del(id) { this.m.delete(id); }
  async clear() { this.m.clear(); }
}

class IdbBackend {
  constructor(db) { this.db = db; this.persistent = true; }
  static open(idb) {
    return new Promise((resolve, reject) => {
      const r = idb.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => resolve(new IdbBackend(r.result));
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    });
  }
  #store(mode) { const t = this.db.transaction(STORE, mode); return [t.objectStore(STORE), t]; }
  async all() { const [s] = this.#store('readonly'); return req(s.getAll()); }
  async get(id) { const [s] = this.#store('readonly'); return req(s.get(id)); }
  async put(rec) { const [s, t] = this.#store('readwrite'); const id = await req(s.put(rec)); await tx(t); return id; }
  async del(id) { const [s, t] = this.#store('readwrite'); s.delete(id); await tx(t); }
  async clear() { const [s, t] = this.#store('readwrite'); s.clear(); await tx(t); }
}

export async function openLibrary(idb = globalThis.indexedDB) {
  let backend;
  try { backend = idb ? await IdbBackend.open(idb) : new MemoryBackend(); } catch { backend = new MemoryBackend(); }
  return new Library(backend);
}

const meta = ({ blob, text, chat, ...rest }) => ({ ...rest, chars: text ? text.length : 0, has_summary: !!rest.summary, messages: chat ? chat.length : 0 });

export class Library {
  constructor(backend) { this.b = backend; this.persistent = backend.persistent; }

  async add({ subject, name, kind, size, text, blob }) {
    return this.b.put({ subject: fold(subject), subject_name: subject, name, kind, size, text, blob: blob || null,
                        added: new Date().toISOString(), summary: '', chat: [] });
  }
  /** Documents d'une matière (sans texte ni fichier), du plus récent au plus ancien. */
  async list(subject) {
    return (await this.b.all()).filter(r => r.subject === fold(subject)).sort((a, b) => b.added.localeCompare(a.added)).map(meta);
  }
  async counts() {
    const out = {};
    for (const r of await this.b.all()) out[r.subject] = (out[r.subject] || 0) + 1;
    return out;
  }
  /** Cours dont le rappel est dû (le plus en retard d'abord), et le prochain rappel à venir s'il n'y en a pas. */
  async withSrs() { return (await this.b.all()).filter(r => r.srs).map(meta); }
  async reviews(today) {
    const all = await this.withSrs();
    const due = all.filter(r => r.srs.due <= today).sort((a, b) => a.srs.due.localeCompare(b.srs.due));
    const upcoming = all.filter(r => r.srs.due > today).sort((a, b) => a.srs.due.localeCompare(b.srs.due));
    return { due, next: upcoming[0] || null, total: all.length };
  }
  get(id) { return this.b.get(Number(id)); }
  async update(id, patch) {
    const r = await this.b.get(Number(id));
    if (!r) return null;
    Object.assign(r, patch);
    await this.b.put(r);
    return r;
  }
  remove(id) { return this.b.del(Number(id)); }
  clear() { return this.b.clear(); }
}
