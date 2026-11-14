// Partage d'un planning avec un camarade, sans serveur : le planning est encodé dans un lien (ou un petit fichier).
// Seuls l'emploi du temps et un résumé de stats voyagent : jamais les cours déposés, les notes ni la clé de l'assistant.
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const str = (v, n) => String(v ?? '').slice(0, n);
export const SHARE_MAX_COURSES = 1500;

export function buildShare({ name = '', courses, colors = {}, stats = null, from, to }) {
  const list = courses.filter(c => c.start.slice(0, 10) >= from && c.start.slice(0, 10) <= to)
    .map(c => [c.subject, c.kind || '', c.start, c.end, c.room || '']).slice(0, SHARE_MAX_COURSES);
  return { app: 'campass-partage', v: 1, name: str(name, 40).trim(), courses: list, colors, stats: stats && { weekMin: Math.round(stats.weekMin) || 0, streak: Math.round(stats.streak) || 0 } };
}

/** Valide un partage reçu (lien ou fichier) : on ne garde que des champs connus et typés. */
export function parseShare(raw) {
  if (!raw || typeof raw !== 'object' || raw.app !== 'campass-partage' || raw.v !== 1) throw new Error('Ce lien ou ce fichier n\'est pas un planning partagé.');
  const courses = (Array.isArray(raw.courses) ? raw.courses : []).slice(0, SHARE_MAX_COURSES)
    .filter(c => Array.isArray(c) && DT.test(c[2]) && DT.test(c[3]) && c[3] > c[2] && String(c[0] || '').trim())
    .map(c => ({ subject: str(c[0], 120).trim(), kind: str(c[1], 30), start: c[2], end: c[3], room: str(c[4], 120) }));
  if (!courses.length) throw new Error('Ce partage ne contient aucun cours.');
  const colors = {};
  for (const [k, v] of Object.entries(raw.colors && typeof raw.colors === 'object' ? raw.colors : {})) if (/^#[0-9a-fA-F]{6}$/.test(v)) colors[str(k, 120)] = v;
  const st = raw.stats && typeof raw.stats === 'object' ? { weekMin: Math.max(0, Math.min(99999, Math.round(+raw.stats.weekMin) || 0)), streak: Math.max(0, Math.min(9999, Math.round(+raw.stats.streak) || 0)) } : null;
  return { name: str(raw.name, 40).trim(), courses, colors, stats: st };
}

/** Cours reçus qui ne sont pas déjà dans le planning (même matière, même horaire). */
export function newCourses(incoming, existing, fold) {
  const have = new Set(existing.map(c => `${fold(c.subject)}|${c.start}|${c.end}`));
  return incoming.filter(c => !have.has(`${fold(c.subject)}|${c.start}|${c.end}`));
}

/* ---- encodage compact dans l'URL (deflate si le navigateur sait, sinon JSON brut) */
const b64u = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

export async function encodeShare(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'function') { try { return 'z' + b64u(await pipe(raw, new CompressionStream('deflate-raw'))); } catch { /* repli */ } }
  return 'j' + b64u(raw);
}
export async function decodeShare(code) {
  const t = String(code || '').trim();
  if (t.length > 400000) throw new Error('Lien trop long.');
  try {
    const bytes = unb64u(t.slice(1));
    const raw = t[0] === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : t[0] === 'j' ? bytes : null;
    if (!raw) throw 0;
    return JSON.parse(new TextDecoder().decode(raw));
  } catch { throw new Error('Ce lien de partage est incomplet ou abîmé : demande à ton camarade de le renvoyer.'); }
}
