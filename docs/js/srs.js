// Répétition espacée façon Anki (SM-2 simplifié), au niveau d'un cours entier.
// Un cours « étudié » reçoit un premier rappel le lendemain ; chaque note (oublié / difficile / bien / facile)
// fixe l'intervalle suivant : il s'allonge quand tu retiens bien et retombe à 1 jour quand tu oublies.
export const GRADES = [
  { id: 'again', label: 'Oublié', hint: 'Je ne m\'en souviens pas' },
  { id: 'hard', label: 'Difficile', hint: 'Je m\'en souviens avec effort' },
  { id: 'good', label: 'Bien', hint: 'Je m\'en souviens' },
  { id: 'easy', label: 'Facile', hint: 'Je le maîtrise' },
];
export const MAX_INTERVAL = 365;
const START_EASE = 2.5, MIN_EASE = 1.3;

/* ---- dates ISO « AAAA-MM-JJ » (calcul en UTC : insensible aux changements d'heure) */
const toMs = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const addDays = (iso, n) => new Date(toMs(iso) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 864e5);   // b - a

/** Nouveau cycle : premier rappel le lendemain du jour où le cours est marqué « étudié ». */
export function startCard(today) {
  return { interval: 1, ease: START_EASE, reps: 0, lapses: 0, due: addDays(today, 1), started: today, last: today, log: [] };
}

/** Prochain état de la carte selon la note. Ne modifie pas la carte reçue. */
export function review(card, grade, today) {
  const c = { ...card, log: [...(card.log || [])] };
  const { interval, ease, reps } = card;
  let next, e = ease, r = reps, lapses = card.lapses || 0;
  if (grade === 'again') { next = 1; e = Math.max(MIN_EASE, ease - 0.2); r = 0; lapses++; }
  else if (grade === 'hard') { next = Math.max(2, Math.round(interval * 1.2)); e = Math.max(MIN_EASE, ease - 0.15); r = reps + 1; }
  else if (grade === 'good') { next = reps === 0 ? 3 : reps === 1 ? 7 : Math.round(interval * ease); r = reps + 1; }
  else if (grade === 'easy') { next = reps === 0 ? 5 : reps === 1 ? 12 : Math.round(interval * ease * 1.3); e = ease + 0.15; r = reps + 1; }
  else throw new Error('Note inconnue : ' + grade);
  // jamais plus court que l'intervalle précédent quand on a retenu (sauf « oublié »)
  if (grade !== 'again' && grade !== 'hard') next = Math.max(next, interval + 1);
  next = Math.min(MAX_INTERVAL, Math.max(1, next));
  Object.assign(c, { interval: next, ease: Math.round(e * 100) / 100, reps: r, lapses, due: addDays(today, next), last: today });
  c.log.push({ d: today, g: grade });
  c.log = c.log.slice(-50);
  return c;
}

/** Délai (en jours) que donnerait chaque note : affiché sous les boutons, comme dans Anki. */
export const previewIntervals = (card, today) => Object.fromEntries(GRADES.map(g => [g.id, daysBetween(today, review(card, g.id, today).due)]));

export const isDue = (card, today) => !!card && card.due <= today;
/** Reporte le rappel (sans toucher à l'intervalle ni à la facilité). */
export const snooze = (card, today, days = 1) => ({ ...card, due: addDays(today, days) });

/** « aujourd'hui », « demain », « dans 6 jours », « il y a 2 jours ». */
export function dueLabel(due, today) {
  const n = daysBetween(today, due);
  if (n < -1) return `en retard de ${-n} jours`;
  if (n === -1) return 'en retard d\'un jour';
  if (n === 0) return 'aujourd\'hui';
  if (n === 1) return 'demain';
  return `dans ${n} jours`;
}
export function intervalLabel(days) {
  if (days <= 1) return '1 jour';
  if (days < 30) return `${days} jours`;
  if (days < 365) return `${Math.round(days / 30)} mois`;
  return '1 an';
}

/** Note suggérée d'après la part de questions réussies (l'utilisateur garde le dernier mot). */
export const suggestGrade = ratio => ratio >= 0.9 ? 'easy' : ratio >= 0.6 ? 'good' : ratio >= 0.4 ? 'hard' : 'again';

/* ---- Créneaux facultatifs : les rappels dus sont posés dans les trous libres du calendrier */
export const REMINDER_MINUTES = 15, MAX_REMINDERS_PER_DAY = 3;
const MARGIN = 5;                                       // marge avec les cours, blocages et créneaux de révision voisins
const hm = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);   // « HH:MM »
const dtm = s => +s.slice(11, 13) * 60 + +s.slice(14, 16);  // « AAAA-MM-JJTHH:MM… »
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Premier créneau de `len` minutes libre à partir de `from`, avant `hi` ; null s'il n'y en a pas. */
function firstGap(busy, from, hi, len) {
  let t = Math.ceil(from / 5) * 5;
  for (const [a, b] of [...busy].sort((x, y) => x[0] - y[0])) {
    if (b <= t) continue;
    if (a >= t + len) break;
    t = Math.ceil(b / 5) * 5;
  }
  return t + len <= hi ? t : null;
}

/**
 * items : [{ id, srs }] ; week : réponse de /api/week ; today : 'AAAA-MM-JJ' ; nowMin : minutes écoulées aujourd'hui.
 * Un rappel dû (ou en retard) va aujourd'hui ou le jour dû, dans le premier trou libre ; si la journée est pleine
 * on essaie les deux jours suivants. 3 rappels par jour au plus : le reste reste dans la liste « À revoir ».
 */
export function placeReminders(items, week, today, nowMin = 0) {
  const lo = week.day_start * 60, hi = (week.day_end - 1) * 60;
  const days = Array.from({ length: 7 }, (_, i) => addDays(week.start, i));
  const busy = Object.fromEntries(days.map(d => [d, []]));
  const count = Object.fromEntries(days.map(d => [d, 0]));
  const block = (d, a, b) => busy[d]?.push([a - MARGIN, b + MARGIN]);
  for (const c of week.courses || []) block(c.start.slice(0, 10), dtm(c.start), dtm(c.end));
  for (const b of week.blocks || []) block(b.day, hm(b.start), hm(b.end));
  for (const s of week.sessions || []) block(s.day, dtm(s.start), dtm(s.end));
  const out = [];
  for (const it of [...items].sort((a, b) => a.srs.due.localeCompare(b.srs.due) || a.id - b.id)) {
    const target = it.srs.due < today ? today : it.srs.due;
    for (let k = 0; k <= 2; k++) {
      const day = addDays(target, k);
      if (!(day in busy) || day < today || count[day] >= MAX_REMINDERS_PER_DAY) continue;
      const start = firstGap(busy[day], day === today ? Math.max(lo, nowMin) : lo, hi, REMINDER_MINUTES);
      if (start == null) continue;
      busy[day].push([start - MARGIN, start + REMINDER_MINUTES + MARGIN]); count[day]++;
      out.push({ id: it.id, day, start: hhmm(start), end: hhmm(start + REMINDER_MINUTES), late: it.srs.due < day });
      break;
    }
  }
  return out;
}
