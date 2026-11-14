// Replanification : premier créneau libre d'une journée, répartition des créneaux en retard, priorités.
// Module pur (aucun accès au DOM ni au stockage) pour pouvoir être testé seul.
const pad = n => String(n).padStart(2, '0');
export const STEP = 15;                                          // les heures proposées tombent sur des quarts d'heure

export const toMin = hm => +String(hm).slice(0, 2) * 60 + +String(hm).slice(3, 5);
export const toHM = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const timeOf = dt => toMin(String(dt).slice(11, 16));            // 'YYYY-MM-DDTHH:MM' -> minutes

/** Plages occupées d'un jour (cours, blocages, autres créneaux) d'après la réponse de /api/week. */
export function busyIntervals(week, day, ignoreId = null) {
  const out = [];
  for (const c of week.courses || []) if (String(c.start).slice(0, 10) === day) out.push([timeOf(c.start), timeOf(c.end)]);
  for (const b of week.blocks || []) if (b.day === day) out.push([toMin(b.start), toMin(b.end)]);
  for (const s of week.sessions || []) if (s.day === day && s.id !== ignoreId) out.push([timeOf(s.start), timeOf(s.end)]);
  return out;
}

const overlaps = (busy, a, b) => busy.some(([s, e]) => a < e && b > s);

/**
 * Premier créneau libre de `minutes` minutes entre `dayStart` et `dayEnd` (en heures).
 * `prefer` ('HH:MM') est gardé s'il est libre ; `notBefore` (minutes) évite le passé pour aujourd'hui.
 * Renvoie 'HH:MM' ou null si la journée est pleine.
 */
export function freeSlot(busy, minutes, { dayStart = 8, dayEnd = 22, prefer = null, notBefore = 0 } = {}) {
  const lo = Math.max(dayStart * 60, Math.ceil(notBefore / STEP) * STEP), hi = dayEnd * 60;
  if (prefer) {
    const p = toMin(prefer);
    if (p >= lo && p + minutes <= hi && !overlaps(busy, p, p + minutes)) return toHM(p);
  }
  for (let t = lo; t + minutes <= hi; t += STEP) if (!overlaps(busy, t, t + minutes)) return toHM(t);
  return null;
}

/**
 * Répartit des créneaux sur les jours les moins chargés.
 * `sessions` : [{id, minutes, start}] ; `days` : [{day, load (min déjà prévues), capacity, busy, notBefore?}].
 * Renvoie { moves: [{id, day, start}], unplaced: [id], over: nombre de créneaux qui dépassent la capacité }.
 */
export function spreadSessions(sessions, days, { dayStart = 8, dayEnd = 22 } = {}) {
  const state = days.map(d => ({ ...d, busy: [...(d.busy || [])], load: d.load || 0 }));
  const moves = [], unplaced = [];
  let over = 0;
  for (const s of sessions) {
    let best = null;
    for (const d of state) {
      const start = freeSlot(d.busy, s.minutes, { dayStart, dayEnd, prefer: s.start, notBefore: d.notBefore || 0 });
      if (start === null) continue;
      const ratio = (d.load + s.minutes) / d.capacity;
      if (!best || ratio < best.ratio - 1e-9) best = { d, start, ratio };      // à charge égale, on garde le jour le plus proche
    }
    if (!best) { unplaced.push(s.id); continue; }
    if (best.ratio > 1) over++;
    best.d.load += s.minutes;
    const a = toMin(best.start);
    best.d.busy.push([a, a + s.minutes]);
    moves.push({ id: s.id, day: best.d.day, start: best.start });
  }
  return { moves, unplaced, over };
}

/**
 * Matières à revoir en priorité : d'abord celles qui ont des créneaux en retard, puis celles dont le prochain cours est le plus proche.
 * `sessions` : créneaux de /api/agenda (`status`, `day`, `subject`, `color`, `minutes`, `target` 'YYYY-MM-DDTHH:MM').
 */
export function prioritize(sessions, today) {
  const by = new Map();
  for (const s of sessions) {
    if (s.status !== 'pending') continue;
    const late = s.day < today;
    const g = by.get(s.subject) || { subject: s.subject, color: s.color, count: 0, minutes: 0, late: 0, lateMinutes: 0, nextTarget: null, nextDay: null, learn: 0, practice: 0 };
    g.count++; g.minutes += s.minutes;
    if (s.work === 'practice') g.practice++; else g.learn++;                    // à apprendre (cours) ou exercices (TD)
    if (late) { g.late++; g.lateMinutes += s.minutes; }
    else {
      if (!g.nextDay || s.day < g.nextDay) g.nextDay = s.day;
      if (!g.nextTarget || s.target < g.nextTarget) g.nextTarget = s.target;
    }
    by.set(s.subject, g);
  }
  const key = g => g.nextTarget || '9999';
  return [...by.values()].sort((a, b) => (b.late > 0) - (a.late > 0) || b.lateMinutes - a.lateMinutes
    || key(a).localeCompare(key(b)) || a.subject.localeCompare(b.subject, 'fr'));
}
