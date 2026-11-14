// Stockage local (localStorage) + sauvegarde / restauration en fichier JSON.
// Rien ne quitte le navigateur : pas de serveur, pas de compte.
export const KEY = 'campass-revisions:v2';
export const VERSION = 2;
const MAX_JSON = 8 * 1024 * 1024;

export const emptyState = () => ({
  version: VERSION,
  settings: { ics_url: '', last_sync: '', last_sync_count: '', last_error: '' },
  courses: [], subjects: {}, states: {}, blocks: [], next_block_id: 1,
  recurring_blocks: [], custom_courses: [], next_item_id: 1,   // blocages hebdomadaires, cours ajoutés à la main
});

const HEX = /^#[0-9a-fA-F]{6}$/, DAYRE = /^\d{4}-\d{2}-\d{2}$/, HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const str = (v, max = 300) => String(v ?? '').slice(0, max);
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/** Valide et nettoie des données (importées ou relues) : on ne garde que des champs connus et typés. */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Données illisibles.');
  const s = emptyState();
  const set = raw.settings || {};
  s.settings = { ics_url: str(set.ics_url, 2000), last_sync: str(set.last_sync, 40),
                 last_sync_count: str(set.last_sync_count, 10), last_error: str(set.last_error, 500) };
  s.courses = (Array.isArray(raw.courses) ? raw.courses : []).slice(0, 20000)
    .filter(c => c && DT.test(c.start) && DT.test(c.end))
    .map(c => ({ uid: str(c.uid, 200), subject: str(c.subject, 120) || 'Sans titre', kind: str(c.kind, 30),
                 start: c.start, end: c.end, room: str(c.room, 120), summary: str(c.summary, 300) }));
  for (const [name, v] of Object.entries(raw.subjects && typeof raw.subjects === 'object' ? raw.subjects : {})) {
    if (!v || !name) continue;
    s.subjects[str(name, 120)] = {
      name: str(name, 120), color: HEX.test(v.color) ? v.color : '#64748b',
      session_minutes: Math.round(num(v.session_minutes, 5, 480, 60)), chapters: Math.round(num(v.chapters, 1, 60, 2)),
      chapters_per_session: Math.round(num(v.chapters_per_session, 1, 30, 2)), intensity: num(v.intensity, 0.25, 5, 1), practice_minutes: Math.round(num(v.practice_minutes, 0, 480, 0)),
      enabled: v.enabled === 0 || v.enabled === false ? 0 : 1, backlog: Math.round(num(v.backlog, 0, 99, 0)),
    };
  }
  for (const [sid, v] of Object.entries(raw.states && typeof raw.states === 'object' ? raw.states : {})) {
    if (!v || !/^[0-9a-f]{12}$/.test(sid)) continue;
    s.states[sid] = {
      status: ['pending', 'done', 'missed'].includes(v.status) ? v.status : 'pending',
      moved_date: DAYRE.test(v.moved_date) ? v.moved_date : null, moved_start: HM.test(v.moved_start) ? v.moved_start : null,
      catchup: !!v.catchup, subject: str(v.subject, 120), target_day: DAYRE.test(v.target_day) ? v.target_day : '',
      idx: Number.isInteger(v.idx) ? v.idx : 0, debt_delta: [-1, 0, 1].includes(v.debt_delta) ? v.debt_delta : 0,
    };
    // durée choisie à la main pour ce créneau précis (absente = durée de la matière)
    if (Number.isFinite(Number(v.minutes)) && v.minutes !== null && v.minutes !== '') {
      s.states[sid].minutes = Math.round(num(v.minutes, 5, 480, 60));
    }
  }
  s.blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).slice(0, 5000)
    .filter(b => b && DAYRE.test(b.day) && HM.test(b.start) && HM.test(b.end) && b.end > b.start)
    .map(b => ({ id: Math.round(num(b.id, 1, 1e9, 1)), day: b.day, start: b.start, end: b.end, label: str(b.label, 80) }));
  s.next_block_id = Math.max(Math.round(num(raw.next_block_id, 1, 1e9, 1)), ...s.blocks.map(b => b.id + 1), 1);

  const weekdays = v => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const optDay = v => (DAYRE.test(v) ? v : '');
  s.recurring_blocks = (Array.isArray(raw.recurring_blocks) ? raw.recurring_blocks : []).slice(0, 500)
    .filter(b => b && weekdays(b.weekdays).length && HM.test(b.start) && HM.test(b.end) && b.end > b.start)
    .map(b => ({ id: Math.round(num(b.id, 1, 1e9, 1)), weekdays: weekdays(b.weekdays), start: b.start, end: b.end,
                 label: str(b.label, 80), from: optDay(b.from), until: optDay(b.until) }));
  s.custom_courses = (Array.isArray(raw.custom_courses) ? raw.custom_courses : []).slice(0, 200)
    .filter(c => c && HM.test(c.start) && HM.test(c.end) && c.end > c.start && DAYRE.test(c.from) &&
                 (c.frequency === 'once' || (c.frequency === 'weekly' && weekdays(c.weekdays).length)))
    .map(c => ({ id: Math.round(num(c.id, 1, 1e9, 1)), subject: str(c.subject, 120) || 'Sans titre', kind: str(c.kind, 30),
                 room: str(c.room, 120), start: c.start, end: c.end, frequency: c.frequency,
                 weekdays: c.frequency === 'weekly' ? weekdays(c.weekdays) : [], every: Math.round(num(c.every, 1, 8, 1)),
                 from: c.from, until: optDay(c.until) }));
  s.next_item_id = Math.max(Math.round(num(raw.next_item_id, 1, 1e9, 1)),
    ...s.recurring_blocks.map(b => b.id + 1), ...s.custom_courses.map(c => c.id + 1), 1);
  return s;
}

function browserStorage() {
  try {
    const ls = globalThis.localStorage;
    ls.setItem('__test', '1'); ls.removeItem('__test');
    return ls;
  } catch { return null; }                // navigation privée, stockage bloqué...
}

export class Store {
  constructor(storage = browserStorage()) {
    this.storage = storage;
    this.persistent = !!storage;
    this.state = this.#load();
  }

  #load() {
    try {
      const raw = this.storage && this.storage.getItem(KEY);
      return raw ? normalize(JSON.parse(raw)) : emptyState();
    } catch { return emptyState(); }
  }

  save() {
    if (!this.storage) return;
    try { this.storage.setItem(KEY, JSON.stringify(this.state)); }
    catch { throw new Error('Impossible d\'enregistrer : l\'espace de stockage du navigateur est plein ou bloqué.'); }
  }

  exportJSON() {
    return JSON.stringify({ app: 'campass-revisions', version: VERSION, exported_at: new Date().toISOString(),
                            data: this.state }, null, 2);
  }

  importJSON(text) {
    if (typeof text !== 'string' || text.length > MAX_JSON) throw new Error('Fichier de sauvegarde trop volumineux.');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Ce fichier n\'est pas une sauvegarde valide (JSON illisible).'); }
    if (!parsed || parsed.app !== 'campass-revisions' || !parsed.data) throw new Error('Ce fichier n\'est pas une sauvegarde de Révisions Campass.');
    this.state = normalize(parsed.data);
    this.save();
  }

  reset() {
    this.state = emptyState();
    try { this.storage && this.storage.removeItem(KEY); } catch { /* sans effet */ }
  }
}
