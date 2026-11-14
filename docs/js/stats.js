// Statistiques de révision : journal des créneaux faits + calculs purs (heures par matière, taux, série de jours).
// `log` : { [sid]: { d: 'AAAA-MM-JJ', subject, minutes } }. Un créneau décoché disparaît du journal.
const DAY = 864e5;
const toMs = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromMs = ms => new Date(ms).toISOString().slice(0, 10);

export function cleanLog(raw) {
  const out = {};
  for (const [sid, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v.d) && typeof v.subject === 'string' && Number.isFinite(+v.minutes) && +v.minutes > 0)
      out[String(sid).slice(0, 40)] = { d: v.d, subject: v.subject.slice(0, 120), minutes: Math.min(+v.minutes, 1440) };
  }
  return out;
}
export const mondayOf = day => fromMs(toMs(day) - ((new Date(toMs(day)).getUTCDay() + 6) % 7) * DAY);

/** Minutes révisées par matière depuis le lundi de la semaine de `today`, triées. */
export function weekByDay(log, today) {
  const from = mondayOf(today), per = {}; let total = 0;
  for (const v of Object.values(log)) if (v.d >= from && v.d <= today) { per[v.subject] = (per[v.subject] || 0) + v.minutes; total += v.minutes; }
  return { total, subjects: Object.entries(per).map(([subject, minutes]) => ({ subject, minutes })).sort((a, b) => b.minutes - a.minutes) };
}
/** Jours d'affilée avec au moins un créneau fait, en finissant aujourd'hui (ou hier : la journée n'est pas finie). */
export function streak(log, today) {
  const days = new Set(Object.values(log).map(v => v.d));
  let d = days.has(today) ? today : fromMs(toMs(today) - DAY), n = 0;
  while (days.has(d)) { n++; d = fromMs(toMs(d) - DAY); }
  return n;
}
/** Part des créneaux faits parmi ceux dont le jour est passé ou qui sont faits ; `sessions` : /api/agenda. */
export function doneRate(sessions, today) {
  const due = sessions.filter(s => s.status === 'done' || s.day <= today);
  const done = due.filter(s => s.status === 'done').length;
  return { done, due: due.length, pct: due.length ? Math.round(100 * done / due.length) : null };
}
