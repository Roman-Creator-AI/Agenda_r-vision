// Dates « naïves » (heure locale du planning, sans fuseau) : aucune dérive due à l'heure d'été.
// Un jour = "YYYY-MM-DD", un instant = "YYYY-MM-DDTHH:MM". En calcul on utilise des millisecondes
// "UTC naïves" : seul l'écart entre deux valeurs compte.
export const MIN = 60000;
export const DAY = 86400000;

export const pad2 = n => String(n).padStart(2, '0');

export function dayToMs(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function msToDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export const addDays = (day, n) => msToDay(dayToMs(day) + n * DAY);

export function dtToMs(dt) {
  const [d, t] = dt.split('T');
  const [h, m] = t.split(':').map(Number);
  return dayToMs(d) + (h * 60 + m) * MIN;
}

export function msToDt(ms) {
  const d = new Date(ms);
  return `${msToDay(ms)}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export const hmToMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

/** Lundi = 0 ... dimanche = 6 (comme date.weekday() en Python). */
export const weekday = day => (new Date(dayToMs(day)).getUTCDay() + 6) % 7;

export function todayLocal(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  msToDay(dayToMs(s)) === s;

/** round(x, 2) de Python : valeur binaire exacte, et au pair le plus proche sur les vrais ex æquo (k/8). */
export function round2(x) {
  const eighths = x * 8;
  if (Number.isInteger(eighths) && eighths % 2 !== 0) {       // 0,125 / 0,375 / 0,625 / 0,875 (+ entiers)
    const lo = Math.floor(x * 100);
    return (lo % 2 === 0 ? lo : lo + 1) / 100;
  }
  return Number(x.toFixed(2));
}

/** Arrondi « au pair le plus proche » comme round() de Python (pour des résultats identiques). */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
