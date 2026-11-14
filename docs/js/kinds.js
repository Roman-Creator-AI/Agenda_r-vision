// Cours magistral (CM) : des choses à APPRENDRE. TD / TP : des exercices à TRAVAILLER.
// Module pur : classe les types de séance venus du calendrier (« CM », « TD », « Cours »…) et fournit les libellés associés.
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** 'learn' | 'practice' | 'exam' | 'project' | 'other' d'après le type de séance (« CM », « TD 2 », « Travaux dirigés »…). */
export function workType(kind) {
  const k = norm(kind);
  if (!k) return 'learn';                                         // pas de type : un « cours » par défaut (comme à l'import)
  if (/^(td|tp|tde|exo|exos|exercice|exercices|atelier|soutien|travaux dirige|travaux pratique|seance de travail)/.test(k)) return 'practice';
  if (/^(cm|cours|amphi|lecon|magistral|conference|cc cours)/.test(k)) return 'learn';
  if (/^(examen|ds|dst|partiel|controle|ct|interro|test|oral|soutenance|rattrapage)/.test(k)) return 'exam';
  if (/^(projet|stage|mini projet)/.test(k)) return 'project';
  return 'other';
}

/** Ce que la révision d'une séance demande : 'learn' (apprendre) | 'practice' (exercices) | 'review' (réviser, sans précision). */
export const workOf = kind => { const t = workType(kind); return t === 'learn' || t === 'practice' ? t : 'review'; };

export const WORK = {
  learn:    { icon: '📖', label: 'À apprendre',  action: 'Apprendre le cours',        unit: 'chap.',  doc: 'Cours' },
  practice: { icon: '✏️', label: 'Exercices',    action: 'Refaire les exercices',     unit: 'série',  doc: 'TD & exercices' },
  exam:     { icon: '🎯', label: 'Examen',       action: 'Réviser pour l\'examen',    unit: 'chap.',  doc: 'Cours' },
  review:   { icon: '📚', label: 'À réviser',    action: 'Réviser',                   unit: 'chap.',  doc: 'Cours' },
};

/** « l'examen » ou « le DS » : pour compléter « avant … » / « pour … ». */
export const examNoun = kind => (!String(kind || '').trim() || /^examen$/i.test(String(kind).trim()) ? 'l\'examen' : `le ${String(kind).trim()}`);

/** « CM », « TD »… ; le type générique « Cours » (ou absent) devient « cours ». */
export const kindNoun = kind => (!norm(kind) || norm(kind) === 'cours' ? 'cours' : String(kind).trim());

/** « chap. 1–2 » pour un cours, « série 1–2 » pour un TD. */
export function unitRange(work, chapters) {
  if (!chapters || !chapters.length) return '';
  const unit = (WORK[work] || WORK.review).unit, a = chapters[0], b = chapters[chapters.length - 1];
  return `${unit} ${a}${chapters.length > 1 ? '–' + b : ''}`;
}

/** Type d'un document déposé d'après son nom : « TD3_exercices.pdf » → 'td', « chapitre2.pdf » → 'cours'. */
export function guessTopic(filename) {
  const n = norm(String(filename).replace(/\.[a-z0-9]{1,5}$/i, ''));
  return /(^| )(td|tp|tde|exo|exos|exercice|exercices|feuille|serie|series|corrige|corriges|correction|annale|annales|sujet|ds|partiel)( |\d|$)/.test(n)
    || /(^| )(td|tp)\d/.test(n) ? 'td' : 'cours';
}
export const isPractice = topic => topic === 'td';
