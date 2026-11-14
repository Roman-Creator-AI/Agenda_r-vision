// Confiance par matière : après un créneau (ou un rappel libre), l'étudiant note « 1 = fragile, 2 = moyen, 3 = solide ».
// Les dernières notes décident d'ajuster un peu le temps de révision de la matière.
export const LEVELS = [{ v: 1, icon: '😕', label: 'Fragile' }, { v: 2, icon: '🙂', label: 'Moyen' }, { v: 3, icon: '💪', label: 'Solide' }];
const KEEP = 8, WINDOW = 5;

export function cleanConfidence(raw) {
  const out = {};
  for (const [name, list] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const l = (Array.isArray(list) ? list : []).filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.d) && [1, 2, 3].includes(e.c)).map(e => ({ d: e.d, c: e.c })).slice(-KEEP);
    if (name && l.length) out[String(name).slice(0, 120)] = l;
  }
  return out;
}
export const addRating = (list, level, day) => [...(list || []), { d: day, c: level }].slice(-KEEP);

/** { avg, n, level } sur les dernières notes ; level : 'weak' | 'ok' | 'strong' | null (pas assez de notes). */
export function summary(list) {
  const l = (list || []).slice(-WINDOW);
  if (!l.length) return { avg: null, n: 0, level: null };
  const avg = l.reduce((s, e) => s + e.c, 0) / l.length;
  return { avg: Math.round(avg * 100) / 100, n: l.length, level: l.length < 2 ? null : avg <= 1.7 ? 'weak' : avg >= 2.6 ? 'strong' : 'ok' };
}
/** Coefficient appliqué à l'intensité : +25 % de temps si fragile, −15 % si solide. */
export const intensityFactor = list => ({ weak: 1.25, strong: 0.85 })[summary(list).level] || 1;
