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

/* ---------------------------------------------------------------- défis et objectifs de la semaine */
export const distinctDays = (log, today) => { const from = mondayOf(today); return new Set(Object.values(log).filter(v => v.d >= from && v.d <= today).map(v => v.d)); };

/**
 * Défis de la semaine, calculés à partir du journal. `ctx` : { goalMin, subjects: [noms actifs], lateCount }.
 * Chaque défi : { id, icon, label, done, now, target, unit }.
 */
export function challenges(log, today, ctx = {}) {
  const wk = weekByDay(log, today), days = distinctDays(log, today).size, out = [];
  if (ctx.goalMin > 0) out.push({ id: 'goal', icon: '🎯', label: `Atteindre ${Math.round(ctx.goalMin / 6) / 10} h de révision`, now: Math.min(wk.total, ctx.goalMin), target: ctx.goalMin, unit: 'min', done: wk.total >= ctx.goalMin });
  out.push({ id: 'days', icon: '🔥', label: 'Réviser 4 jours cette semaine', now: Math.min(days, 4), target: 4, unit: 'j', done: days >= 4 });
  const active = (ctx.subjects || []), got = new Set(wk.subjects.map(x => x.subject));
  if (active.length > 1) { const n = active.filter(s => got.has(s)).length; out.push({ id: 'all', icon: '🌈', label: 'Toucher chaque matière', now: n, target: active.length, unit: '', done: n === active.length }); }
  if (ctx.lateCount !== undefined) out.push({ id: 'late', icon: '🧹', label: 'Ne laisser aucun retard', now: ctx.lateCount === 0 ? 1 : 0, target: 1, unit: '', done: ctx.lateCount === 0 });
  return out;
}

/** Bilan de la semaine (pour le dimanche) + texte à partager. */
export function weekRecap(log, sessions, today, ctx = {}) {
  const wk = weekByDay(log, today), rate = doneRate(sessions.filter(s => s.day >= mondayOf(today)), today);
  const got = new Set(wk.subjects.map(x => x.subject));
  return { total: wk.total, best: wk.subjects[0] || null, goalMin: ctx.goalMin || 0, pct: ctx.goalMin ? Math.round(100 * wk.total / ctx.goalMin) : null,
           neglected: (ctx.subjects || []).filter(s => !got.has(s)), streak: streak(log, today), rate };
}
export function recapText(r, fmt, name = '') {
  const l = [`📚 ${name ? name + ' · ' : ''}Ma semaine de révisions : ${fmt(r.total)}${r.pct !== null ? ` (${r.pct} % de mon objectif)` : ''}`];
  if (r.best) l.push(`🏆 Matière la plus travaillée : ${r.best.subject} (${fmt(r.best.minutes)})`);
  if (r.rate.pct !== null) l.push(`✅ ${r.rate.pct} % des créneaux faits`);
  if (r.streak) l.push(`🔥 ${r.streak} jour${r.streak > 1 ? 's' : ''} d'affilée`);
  if (r.neglected.length) l.push(`⚠️ À rattraper : ${r.neglected.join(', ')}`);
  return l.join('\n');
}
