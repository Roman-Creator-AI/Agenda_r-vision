// Fiches mémoire : de petites cartes question/réponse par cours, chacune avec son propre calendrier de rappel (SM-2, voir srs.js).
// Module pur : la liste des fiches d'un cours vit dans son enregistrement (champ `cards`).
import { startCard, review } from './srs.js';

const norm = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

/** Nouvelle fiche : à apprendre dès aujourd'hui (le premier rappel n'attend pas demain). */
export const makeCard = ({ q, a }, today) => ({ id: newId(), q: String(q).trim().slice(0, 500), a: String(a).trim().slice(0, 1500), srs: { ...startCard(today), due: today } });

export function cleanCards(raw) {
  const out = [], seen = new Set();
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c.q !== 'string' || typeof c.a !== 'string' || !c.q.trim() || !c.a.trim() || !c.srs || !/^\d{4}-\d{2}-\d{2}$/.test(c.srs.due)) continue;
    const k = norm(c.q); if (seen.has(k)) continue; seen.add(k);
    out.push({ id: String(c.id || newId()).slice(0, 20), q: c.q.slice(0, 500), a: c.a.slice(0, 1500), srs: c.srs });
  }
  return out.slice(0, 300);
}

/** Ajoute des fiches {q, a} en écartant les doublons (même question) ; renvoie la nouvelle liste et le nombre ajouté. */
export function addCards(existing, fresh, today) {
  const list = cleanCards(existing), seen = new Set(list.map(c => norm(c.q)));
  let added = 0;
  for (const f of fresh) {
    if (!f || !String(f.q || '').trim() || !String(f.a || '').trim() || seen.has(norm(f.q)) || list.length >= 300) continue;
    seen.add(norm(f.q)); list.push(makeCard(f, today)); added++;
  }
  return { cards: list, added };
}

/** Fiches à revoir aujourd'hui dans tous les cours (la plus en retard d'abord). `records` : enregistrements de la bibliothèque. */
export function dueCards(records, today, keep = () => true) {
  const out = [];
  for (const r of records) if (keep(r)) for (const c of cleanCards(r.cards)) if (c.srs.due <= today) out.push({ docId: r.id, subject: r.subject_name, docName: r.name, card: c });
  return out.sort((a, b) => a.card.srs.due.localeCompare(b.card.srs.due) || a.card.id.localeCompare(b.card.id));
}
export const gradeCard = (card, grade, today) => ({ ...card, srs: review(card.srs, grade, today) });

/** Demande à l'IA des fiches : JSON uniquement. `known` : questions déjà existantes, à ne pas répéter. */
export const cardsRequest = (n, known = []) => `Crée ${n} fiches de mémorisation (question / réponse) pour apprendre ce document par cœur.
Une fiche = une seule notion : définition, formule, théorème, date, méthode, différence entre deux notions… Question courte et précise ; réponse en une à deux phrases, fidèle au document.
${known.length ? `Ne répète pas ces questions déjà existantes :\n${known.slice(0, 40).map(q => '- ' + q).join('\n')}\n` : ''}Réponds UNIQUEMENT par un tableau JSON, sans texte autour : [{"q":"question","a":"réponse"}, ...]`;

export function parseCards(text, max = 25) {
  const t = String(text || ''), i = t.indexOf('['), j = t.lastIndexOf(']');
  if (i < 0 || j <= i) return null;
  let arr; try { arr = JSON.parse(t.slice(i, j + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const out = arr.filter(c => c && typeof c.q === 'string' && typeof c.a === 'string' && c.q.trim() && c.a.trim()).slice(0, max).map(c => ({ q: c.q.trim(), a: c.a.trim() }));
  return out.length ? out : null;
}

/** Rappel libre : l'étudiant écrit ce dont il se souvient, l'IA le compare au cours. */
export const recallRequest = recall => `Voici tout ce dont l'étudiant se souvient de ce document, écrit de mémoire :
<souvenirs>
${String(recall).slice(0, 8000)}
</souvenirs>
Compare avec le document et réponds en français, de façon brève et encourageante, avec ces trois titres :
**Bien retenu** (2 à 5 points exacts), **À compléter** (les notions importantes oubliées), **À corriger** (les erreurs, s'il y en a).
Termine par une ligne « **Maîtrise estimée :** faible, moyenne ou bonne ».`;
