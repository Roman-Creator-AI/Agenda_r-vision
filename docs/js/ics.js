// Lecture d'un flux ICS dans le navigateur (ical.js) — équivalent de ics_service.py.
import ICAL from '../vendor/ical.min.js';
import { addDays, dtToMs, msToDt, pad2, MIN } from './dates.js';

export const MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULTS = {
  timezone: 'Europe/Paris', pastDays: 30, futureDays: 150, ignore: /(férié|vacances|fermeture)/i,
};

export class IcsError extends Error {}

// `\b` de JavaScript ignore les lettres accentuées : on utilise des classes Unicode (sans lookbehind,
// pour rester compatible avec les anciens Safari).
const kind = core => new RegExp(`(^|[^\\p{L}\\p{N}_])(${core})(?![\\p{L}\\p{N}_])`, 'iu');
const KIND_PATTERNS = [
  ['CM', kind('CM|cours magistral|amphi')],
  ['TD', kind('TD|travaux dirig[ée]s?')],
  ['TP', kind('TP|travaux pratiques?')],
  ['Examen', kind('DS|examen|partiel|contr[oô]le|CC')],
  ['Projet', kind('projet')],
  ['Cours', kind('cours')],
];

const squash = s => String(s ?? '').split(/\s+/).filter(Boolean).join(' ');

/** Retourne [matière, type]. « Mathématiques 1 - CS+R - CM - S12 » -> ['Mathématiques 1', 'CM']. */
export function parseSummary(raw) {
  const summary = squash(raw);
  let type = 'Cours', subject = summary;
  if (summary.includes(' - ')) {                    // format Geode : la matière est le premier segment
    const [head, ...rest] = summary.split(' - ').map(p => p.trim());
    const restText = rest.join(' ');
    for (const [label, re] of KIND_PATTERNS) if (re.test(restText)) { type = label; break; }
    return [head || summary, type];
  }
  for (const [label, re] of KIND_PATTERNS) {
    if (re.test(summary)) { type = label; subject = summary.replace(re, '$1 '); break; }
  }
  subject = subject.replace(/[[\]()]/g, ' ').replace(/^[\s\-–:|/,]+|[\s\-–:|/,]+$/g, '');
  subject = squash(subject);
  return [subject || summary || 'Sans titre', type];
}

// ---------------------------------------------------------------- fuseaux horaires
const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }));
  }
  return formatters.get(tz);
}

/** Instant (ms) -> heure murale « YYYY-MM-DDTHH:MM » dans le fuseau du planning. */
export function wallTime(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

/** Heure murale d'un fuseau IANA -> instant (ms). */
function zonedToMs(y, mo, d, h, mi, tz) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = ms => dtToMs(wallTime(ms, tz)) - ms;
  const first = asUtc - offsetAt(asUtc);          // 1re approximation
  return asUtc - offsetAt(first);                 // 2e passe : exacte, même autour d'un changement d'heure
}

/** Heure ical.js -> heure murale du planning, ou null pour un événement « toute la journée ». */
function toLocal(t, tz, tzidParam) {
  if (!t || t.isDate) return null;
  const floating = !t.zone || t.zone === ICAL.Timezone.localTimezone || t.zone.tzid === 'floating';
  if (floating) {
    if (tzidParam && tzidParam !== tz) {            // TZID IANA sans VTIMEZONE dans le fichier
      try { return wallTime(zonedToMs(t.year, t.month, t.day, t.hour, t.minute, tzidParam), tz); } catch { /* inconnu */ }
    }
    return `${t.year}-${pad2(t.month)}-${pad2(t.day)}T${pad2(t.hour)}:${pad2(t.minute)}`;
  }
  return wallTime(t.toUnixTime() * 1000, tz);
}

// ---------------------------------------------------------------- analyse du flux
export function parseICS(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const today = o.today;
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new IcsError('Fichier ICS trop volumineux (> 5 Mo).');
  let cal;
  try { cal = new ICAL.Component(ICAL.parse(text)); } catch { throw new IcsError('Fichier ICS illisible.'); }
  if (cal.name !== 'vcalendar') throw new IcsError('Ce fichier n\'est pas un calendrier ICS.');
  for (const vtz of cal.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(vtz); } catch { /* fuseau incomplet : on l'ignore */ }
  }

  const masters = new Map(), singles = [], exceptions = [];
  for (const v of cal.getAllSubcomponents('vevent')) {
    let ev;
    try { ev = new ICAL.Event(v); } catch { continue; }
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else { singles.push(ev); if (ev.uid) masters.set(ev.uid, ev); }
  }
  for (const ex of exceptions) {                    // occurrences déplacées ou modifiées
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex); else singles.push(ex);
  }

  const winStart = addDays(today, -o.pastDays), winEnd = addDays(today, o.futureDays);
  const out = [], seen = new Set();
  const push = (ev, startT, endT) => {
    const summary = String(ev.summary || '').trim();
    const tzid = ev.component.getFirstProperty('dtstart')?.getParameter('tzid') || '';
    const begin = toLocal(startT, o.timezone, tzid);
    if (!begin) return;
    const day = begin.slice(0, 10);
    if (day < winStart || day >= winEnd) return;
    let finish = endT ? toLocal(endT, o.timezone, tzid) : null;
    if (!finish || dtToMs(finish) <= dtToMs(begin)) finish = msToDt(dtToMs(begin) + 60 * MIN);
    const [subject, type] = parseSummary(summary);
    const key = `${subject.toLowerCase()}|${type}|${begin}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ uid: ev.uid || '', subject, kind: type, start: begin, end: finish,
               room: String(ev.location || '').trim(), summary });
  };

  for (const ev of singles) {
    const summary = String(ev.summary || '').trim();
    if (o.ignore && o.ignore.test(summary)) continue;
    if (!ev.isRecurring()) { push(ev, ev.startDate, ev.endDate); continue; }
    const it = ev.iterator();
    for (let next = it.next(), guard = 0; next && guard < 5000; next = it.next(), guard++) {
      const d = ev.getOccurrenceDetails(next);
      const first = toLocal(d.startDate, o.timezone, '');
      if (first && first.slice(0, 10) >= winEnd) break;      // les occurrences arrivent dans l'ordre
      push(ev, d.startDate, d.endDate);
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- téléchargement
const CORS_HINT = 'Le navigateur n\'a pas pu lire ce lien : le serveur de l\'emploi du temps ne l\'autorise pas depuis ' +
  'un autre site (CORS), ou le lien est incorrect. Télécharge le fichier .ics depuis ton emploi du temps et importe-le ici.';

export async function fetchICS(url, fetchFn = globalThis.fetch) {
  url = String(url || '').trim();
  if (/^webcal:\/\//i.test(url)) url = 'https://' + url.slice(9);
  if (!/^https?:\/\//i.test(url)) throw new IcsError('URL invalide : elle doit commencer par https:// ou webcal://');
  let res;
  try { res = await fetchFn(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' }); }
  catch { throw new IcsError(CORS_HINT); }
  if (!res.ok) throw new IcsError(`Le serveur a répondu ${res.status}.`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new IcsError('Fichier ICS trop volumineux (> 5 Mo).');
  return text;
}
