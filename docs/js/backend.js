// « Backend » exécuté dans le navigateur : mêmes routes et mêmes réponses JSON que l'API Flask
// (app.py), mais les données vivent dans le localStorage de l'appareil.
import { DEFAULT_CFG, DEFAULT_SUBJECT, plan, dailyLoad, workload } from './planner.js';
import { DAY, addDays, dayToMs, isDay, todayLocal, weekday, pad2 } from './dates.js';
import { IcsError, fetchICS, parseICS } from './ics.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const PALETTE = ['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0891b2',
                 '#ca8a04', '#dc2626', '#4f46e5', '#0d9488', '#9333ea', '#65a30d'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/, HEX = /^#[0-9a-fA-F]{6}$/;
const STATUSES = new Set(['pending', 'done', 'missed']);
const fold = s => String(s).toLowerCase();

export function colorFor(name, sha1Hex) {      // même couleur que la version Python (sha1 mod 12)
  let r = 0;
  for (const ch of sha1Hex(fold(name))) r = (r * 16 + parseInt(ch, 16)) % PALETTE.length;
  return PALETTE[r];
}

const localIso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T` +
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

export async function createBackend({ store, today = () => todayLocal(), now = () => new Date(),
                                      fetchFn = globalThis.fetch, cfg = {}, timezone = 'Europe/Paris' } = {}) {
  const { sha1Hex } = await import('./sha1.js');
  const CFG = { ...DEFAULT_CFG, ...cfg };
  const AUTO_REFRESH_MINUTES = cfg.autoRefreshMinutes ?? 60;
  const S = () => store.state;

  const err = (status, msg) => new ApiError(status, msg);
  const findSubject = name => Object.keys(S().subjects).find(k => fold(k) === fold(name));

  // ------------------------------------------------------------ calcul du planning
  function subjectCfgs() {
    const out = {};
    for (const s of Object.values(S().subjects)) {
      out[s.name] = { name: s.name, color: s.color, sessionMinutes: s.session_minutes, chapters: s.chapters,
                      chaptersPerSession: s.chapters_per_session, intensity: s.intensity,
                      enabled: !!s.enabled, backlog: s.backlog };
    }
    return out;
  }

  // ------------------------------------------------------------ cours ajoutés / blocages hebdomadaires
  const DEFAULT_WEEKS = 20;          // durée d'une série hebdomadaire sans date de fin
  const MAX_SPAN_DAYS = 400;         // garde-fou : une série ne dépasse pas ~13 mois

  /** Occurrences d'un blocage hebdomadaire entre deux jours (inclus). */
  function recurringBlockDays(rb, from, to) {
    const lo = rb.from && rb.from > from ? rb.from : from;
    const hi = rb.until && rb.until < to ? rb.until : to;
    const out = [];
    if (hi < lo || (dayToMs(hi) - dayToMs(lo)) / DAY > 1500) return out;
    for (let d = lo; d <= hi; d = addDays(d, 1)) {
      if (rb.weekdays.includes(weekday(d))) {
        out.push({ id: rb.id, day: d, start: rb.start, end: rb.end, label: rb.label, recurring: true });
      }
    }
    return out;
  }

  /** Occurrences (au format des cours importés) d'un cours ajouté à la main. */
  function customCourseOccurrences(c) {
    const make = day => ({
      uid: `custom-${c.id}-${day}`, subject: c.subject, kind: c.kind, start: `${day}T${c.start}`, end: `${day}T${c.end}`,
      room: c.room, summary: [c.subject, c.kind].filter(Boolean).join(' '), custom: true, cid: c.id,
    });
    if (c.frequency === 'once') return [make(c.from)];
    const until = c.until || addDays(c.from, DEFAULT_WEEKS * 7 - 1);
    const firstMonday = addDays(c.from, -weekday(c.from));
    const out = [];
    for (let d = c.from; d <= until; d = addDays(d, 1)) {
      if (!c.weekdays.includes(weekday(d))) continue;
      const weeks = Math.round((dayToMs(addDays(d, -weekday(d))) - dayToMs(firstMonday)) / (7 * DAY));
      if (weeks % c.every === 0) out.push(make(d));
    }
    return out;
  }

  /** Cours importés (ICS) + cours ajoutés à la main, développés en occurrences. */
  const allCourses = () => S().courses.concat(...S().custom_courses.map(customCourseOccurrences));

  function buildPlan() {
    const subjects = subjectCfgs();
    const courses = allCourses();
    // Les blocages hebdomadaires sont développés en jours précis sur la période couverte par les cours.
    const days = courses.map(c => c.start.slice(0, 10)).sort();
    const recurring = days.length
      ? S().recurring_blocks.flatMap(rb => recurringBlockDays(rb, addDays(days[0], -1), addDays(days[days.length - 1], 1)))
      : [];
    const sessions = plan(courses, subjects, S().states, S().blocks.concat(recurring), CFG, today());
    return { sessions, subjects };
  }

  const ser = (s, subjects) => ({
    id: s.sid, subject: s.subject, color: (subjects[s.subject] || {}).color || '#64748b',
    day: s.day, start: s.start, end: s.end, minutes: s.minutes, target: s.targetStart,
    slot_index: s.slotIndex, slot_count: s.slotCount, chapters: s.chapters,
    status: s.status, done: s.done, catchup: s.catchup, moved: s.moved, overloaded: s.overloaded,
    overdue: s.day < today() && s.status === 'pending',
    custom_minutes: !!(S().states[s.sid] && S().states[s.sid].minutes),     // durée fixée à la main
  });

  const metaOf = s => ({ catchup: s.catchup, subject: s.subject, target_day: s.targetStart.slice(0, 10), idx: s.idx });

  // ------------------------------------------------------------ état des créneaux
  function ensureState(sid, meta) {
    const st = S().states[sid] || (S().states[sid] = {
      status: 'pending', moved_date: null, moved_start: null, debt_delta: 0 });
    Object.assign(st, { catchup: !!meta.catchup, subject: meta.subject, target_day: meta.target_day, idx: meta.idx });
    return st;
  }

  /** Change le statut et met à jour le retard : base « Non fait » +1, rattrapage « Fait » −1, annulable. */
  function setStatus(sid, meta, status) {
    const st = ensureState(sid, meta);
    const old = st.debt_delta || 0;
    const delta = status === 'missed' && !meta.catchup ? 1 : status === 'done' && meta.catchup ? -1 : 0;
    st.status = status; st.debt_delta = delta;
    const key = findSubject(meta.subject);
    if (key && delta !== old) S().subjects[key].backlog = Math.max(0, S().subjects[key].backlog + delta - old);
    return key ? S().subjects[key].backlog : 0;
  }

  // ------------------------------------------------------------ synchronisation ICS
  function ensureSubjects(names) {
    for (const n of names) {
      if (!findSubject(n)) {
        S().subjects[n] = { name: n, color: colorFor(n, sha1Hex), ...{
          session_minutes: DEFAULT_SUBJECT.sessionMinutes, chapters: DEFAULT_SUBJECT.chapters,
          chapters_per_session: DEFAULT_SUBJECT.chaptersPerSession, intensity: DEFAULT_SUBJECT.intensity,
          enabled: 1, backlog: 0 } };
      }
    }
  }

  function doSync(text) {
    const courses = parseICS(text, { today: today(), timezone });
    S().courses = courses;
    ensureSubjects([...new Set(courses.map(c => c.subject))].sort());
    Object.assign(S().settings, { last_sync: localIso(now()), last_sync_count: String(courses.length), last_error: '' });
    store.save();
    return { count: courses.length, subjects: new Set(courses.map(c => fold(c.subject))).size };
  }

  async function syncFromUrl(url) {
    try { return doSync(await fetchICS(url, fetchFn)); }
    catch (e) {
      if (e instanceof IcsError) { S().settings.last_error = e.message; store.save(); throw err(502, e.message); }
      throw e;
    }
  }

  /** Rafraîchit en silence à l'ouverture si le lien est connu et que la dernière synchro est ancienne. */
  async function autoSync() {
    const { ics_url: url, last_sync: last } = S().settings;
    if (!url || !AUTO_REFRESH_MINUTES) return null;
    if (last && (now() - new Date(last)) < AUTO_REFRESH_MINUTES * 60000) return null;
    try { return await syncFromUrl(url); } catch { return null; }   // l'erreur est mémorisée dans les réglages
  }

  // ------------------------------------------------------------ validations
  const toInt = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
    throw new TypeError('nombre');
  };
  const toFloat = v => {
    const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
    if (!Number.isFinite(n)) throw new TypeError('nombre');
    return n;
  };

  const parseWeekdays = v => [...new Set((Array.isArray(v) ? v : [v]).filter(x => x !== undefined && x !== '' && x !== null)
    .map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const optionalDay = (v, label) => {
    if (v === undefined || v === null || v === '') return '';
    if (!isDay(v)) throw err(400, `Date ${label} invalide.`);
    return v;
  };

  // ------------------------------------------------------------ routes
  async function handle(method, path, body = {}) {
    body = body || {};
    const url = new URL(path, 'http://local');
    const p = url.pathname, q = url.searchParams;
    let m;

    if (method === 'GET' && p === '/api/settings') {
      const st = S().settings, u = st.ics_url;
      return { ics_configured: !!u, ics_url_masked: u ? '…' + u.slice(-6) : '', last_sync: st.last_sync,
               last_sync_count: st.last_sync_count, last_error: st.last_error,
               auto_refresh_minutes: AUTO_REFRESH_MINUTES, capacity: CFG.capacity, persistent: store.persistent };
    }
    if (method === 'PUT' && p === '/api/settings') {
      const u = String(body.ics_url || '').trim();
      if (u) {
        if (!/^(https?|webcal):\/\//i.test(u)) throw err(400, 'L\'URL doit commencer par https:// ou webcal://');
        S().settings.ics_url = u; store.save();
      }
      return { ok: true };
    }
    if (method === 'POST' && p === '/api/sync') {
      const u = String(body.url || '').trim() || S().settings.ics_url;
      if (!u) throw err(400, 'Aucun lien ICS enregistré. Saisis-le ou importe un fichier .ics.');
      const info = await syncFromUrl(u);
      if (body.url) { S().settings.ics_url = u; store.save(); }
      return info;
    }
    if (method === 'POST' && p === '/api/upload') {
      try { return doSync(String(body.text || '')); }
      catch (e) { if (e instanceof IcsError) throw err(400, e.message); throw e; }
    }
    if (method === 'GET' && p === '/api/export') return { text: store.exportJSON() };
    if (method === 'POST' && p === '/api/import') {
      try { store.importJSON(String(body.text || '')); } catch (e) { throw err(400, e.message); }
      return { ok: true };
    }
    if (method === 'POST' && p === '/api/reset') { store.reset(); return { ok: true }; }

    if (method === 'GET' && p === '/api/week') {
      let monday = isDay(q.get('start')) ? q.get('start') : today();
      monday = addDays(monday, -weekday(monday));
      const end = addDays(monday, 7);
      const colors = Object.fromEntries(Object.values(S().subjects).map(s => [fold(s.name), s.color]));
      const courses = allCourses().filter(c => c.start < end && c.end > monday)
        .map(c => ({ ...c, color: colors[fold(c.subject)] || '#64748b' }));
      const { sessions, subjects } = buildPlan();
      const load = dailyLoad(sessions, CFG.capacity);
      const blocks = S().blocks.filter(b => b.day >= monday && b.day < end)
        .concat(...S().recurring_blocks.map(rb => recurringBlockDays(rb, monday, addDays(end, -1))));
      return {
        start: monday, courses, sessions: sessions.filter(s => s.day >= monday && s.day < end).map(s => ser(s, subjects)),
        blocks: blocks.sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start)),
        load: Object.fromEntries(Object.entries(load).filter(([k]) => k >= monday && k < end)),
        day_start: Math.floor(CFG.dayStart / 60), day_end: Math.floor(CFG.dayEnd / 60) + 1,
      };
    }
    if (method === 'GET' && p === '/api/today') {
      const { sessions, subjects } = buildPlan();
      const t = today();
      const load = dailyLoad(sessions, CFG.capacity)[t] ||
        { minutes: 0, done_minutes: 0, capacity: CFG.capacity, ratio: 0, level: 'ok' };
      return {
        date: t,
        todo: sessions.filter(s => s.day === t || (s.day < t && s.status === 'pending')).map(s => ser(s, subjects)),
        load,
        upcoming: sessions.filter(s => s.day > t && s.status === 'pending').slice(0, 5).map(s => ser(s, subjects)),
      };
    }
    if (method === 'GET' && p === '/api/agenda') {
      const { sessions, subjects } = buildPlan();
      return { sessions: sessions.map(s => ser(s, subjects)), load: dailyLoad(sessions, CFG.capacity) };
    }
    if (method === 'PATCH' && (m = p.match(/^\/api\/sessions\/([0-9a-f]+)$/))) {
      const { sessions } = buildPlan();
      const s = sessions.find(x => x.sid === m[1]);
      if (!s) throw err(404, 'Créneau introuvable (le planning a peut-être changé).');
      const out = { ok: true };
      let status = body.status;
      if (status === undefined && 'done' in body) status = body.done ? 'done' : 'pending';
      if (status !== undefined && status !== null) {
        if (!STATUSES.has(status)) throw err(400, 'Statut invalide.');
        out.backlog = setStatus(s.sid, metaOf(s), status);
      }
      if ('minutes' in body) {                 // durée propre à ce créneau (null = revenir à celle de la matière)
        const st = ensureState(s.sid, metaOf(s));
        if (body.minutes === null) delete st.minutes;
        else {
          let v;
          try { v = toInt(body.minutes); } catch { throw err(400, 'Durée invalide.'); }
          if (v < 5 || v > 480) throw err(400, 'La durée doit être comprise entre 5 minutes et 8 h.');
          st.minutes = v;
        }
      }
      if (body.reset) {
        const st = ensureState(s.sid, metaOf(s)); st.moved_date = null; st.moved_start = null;
      } else if ('day' in body && 'start' in body) {
        if (!isDay(body.day) || !HHMM.test(String(body.start))) throw err(400, 'Date ou heure invalide.');
        const st = ensureState(s.sid, metaOf(s)); st.moved_date = body.day; st.moved_start = body.start;
      }
      store.save();
      return out;
    }
    if (method === 'GET' && p === '/api/subjects') {
      return Object.values(S().subjects).sort((a, b) => fold(a.name).localeCompare(fold(b.name))).map(s => {
        const [slots, minutes] = workload({ chapters: s.chapters, chaptersPerSession: s.chapters_per_session,
                                            sessionMinutes: s.session_minutes, intensity: s.intensity });
        return { ...s, slots, slot_minutes: minutes, total_minutes: slots * minutes, debt_minutes: s.backlog * minutes };
      });
    }
    if (method === 'PUT' && p === '/api/subjects') {
      if (!body.name) throw err(400, 'Nom de matière manquant.');
      const fields = {};
      try {
        const rules = { session_minutes: [toInt, 5, 480], chapters: [toInt, 1, 60], chapters_per_session: [toInt, 1, 30],
                        intensity: [toFloat, 0.25, 5.0], backlog: [toInt, 0, 99] };
        for (const [key, [cast, lo, hi]] of Object.entries(rules)) {
          if (!(key in body)) continue;
          const v = cast(body[key]);
          if (v < lo || v > hi) throw err(400, `${key} doit être entre ${lo} et ${hi}.`);
          fields[key] = v;
        }
      } catch (e) { if (e instanceof ApiError) throw e; throw err(400, 'Valeur numérique invalide.'); }
      if ('color' in body) {
        if (!HEX.test(String(body.color))) throw err(400, 'Couleur invalide (#rrggbb).');
        fields.color = body.color;
      }
      if ('enabled' in body) fields.enabled = body.enabled ? 1 : 0;
      const key = findSubject(body.name);
      if (!key || !Object.keys(fields).length) throw err(404, 'Matière introuvable.');
      Object.assign(S().subjects[key], fields); store.save();
      return { ok: true };
    }
    if (method === 'GET' && p === '/api/blocks') {
      return [...S().blocks].sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start));
    }
    if (method === 'POST' && p === '/api/blocks') {
      if (!isDay(body.day) || !HHMM.test(String(body.start || '')) || !HHMM.test(String(body.end || '')) ||
          body.end <= body.start) throw err(400, 'Jour/heures invalides (la fin doit suivre le début).');
      S().blocks.push({ id: S().next_block_id++, day: body.day, start: body.start, end: body.end,
                        label: String(body.label || '').slice(0, 80) });
      store.save();
      return { ok: true };
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/blocks\/(\d+)$/))) {
      S().blocks = S().blocks.filter(b => b.id !== Number(m[1])); store.save();
      return { ok: true };
    }

    // ---- blocages hebdomadaires (ex : tous les lundis de 17h30 à 19h)
    if (method === 'GET' && p === '/api/recurring-blocks') {
      return [...S().recurring_blocks].sort((a, b) => a.weekdays[0] - b.weekdays[0] || a.start.localeCompare(b.start));
    }
    if (method === 'POST' && p === '/api/recurring-blocks') {
      const wd = parseWeekdays(body.weekdays);
      if (!wd.length) throw err(400, 'Choisis au moins un jour de la semaine.');
      if (!HHMM.test(String(body.start || '')) || !HHMM.test(String(body.end || '')) || body.end <= body.start) {
        throw err(400, 'Heures invalides (la fin doit suivre le début).');
      }
      const from = optionalDay(body.from, 'de début'), until = optionalDay(body.until, 'de fin');
      if (from && until && until < from) throw err(400, 'La date de fin précède la date de début.');
      S().recurring_blocks.push({ id: S().next_item_id++, weekdays: wd, start: body.start, end: body.end,
                                  label: String(body.label || '').slice(0, 80), from, until });
      store.save();
      return { ok: true };
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/recurring-blocks\/(\d+)$/))) {
      S().recurring_blocks = S().recurring_blocks.filter(b => b.id !== Number(m[1])); store.save();
      return { ok: true };
    }

    // ---- cours ajoutés à la main, avec leur fréquence
    if (method === 'GET' && p === '/api/custom-courses') {
      return [...S().custom_courses].sort((a, b) => fold(a.subject).localeCompare(fold(b.subject)));
    }
    if (method === 'POST' && p === '/api/custom-courses') {
      const subject = String(body.subject || '').trim().slice(0, 120);
      if (!subject) throw err(400, 'Donne un nom à ce cours.');
      if (!HHMM.test(String(body.start || '')) || !HHMM.test(String(body.end || '')) || body.end <= body.start) {
        throw err(400, 'Heures invalides (la fin doit suivre le début).');
      }
      if (!isDay(body.from)) throw err(400, 'Date invalide.');
      const frequency = body.frequency === 'once' ? 'once' : 'weekly';
      const course = { id: S().next_item_id, subject, kind: String(body.kind || '').trim().slice(0, 30),
                       room: String(body.room || '').trim().slice(0, 120), start: body.start, end: body.end,
                       frequency, weekdays: [], every: 1, from: body.from, until: '' };
      if (frequency === 'weekly') {
        course.weekdays = parseWeekdays(body.weekdays);
        if (!course.weekdays.length) throw err(400, 'Choisis au moins un jour de la semaine.');
        let every;
        try { every = body.every === undefined || body.every === '' ? 1 : toInt(body.every); } catch { every = 0; }
        if (every < 1 || every > 8) throw err(400, 'La fréquence doit être entre 1 et 8 (toutes les N semaines).');
        course.every = every;
        course.until = optionalDay(body.until, 'de fin');
        if (course.until && course.until < course.from) throw err(400, 'La date de fin précède la date de début.');
        if (course.until && (dayToMs(course.until) - dayToMs(course.from)) / DAY > MAX_SPAN_DAYS) {
          throw err(400, 'La série est trop longue (13 mois maximum).');
        }
      }
      S().next_item_id++;
      S().custom_courses.push(course);
      ensureSubjects([subject]);
      store.save();
      return { ok: true, occurrences: customCourseOccurrences(course).length };
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/custom-courses\/(\d+)$/))) {
      S().custom_courses = S().custom_courses.filter(c => c.id !== Number(m[1])); store.save();
      return { ok: true };
    }
    throw err(404, `Route inconnue : ${method} ${p}`);
  }

  return { handle, autoSync, syncFromUrl, today };
}

