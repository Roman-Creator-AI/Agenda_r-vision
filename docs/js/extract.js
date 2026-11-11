// Extraction du texte des cours téléversés (PDF, Word .docx, texte / Markdown), entièrement dans le navigateur.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 1500000;

export const kindOf = (name, mime = '') => {
  const n = String(name).toLowerCase();
  if (n.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (n.endsWith('.docx') || mime.includes('wordprocessingml')) return 'docx';
  if (/\.(txt|md|markdown)$/.test(n) || mime.startsWith('text/')) return 'text';
  return null;
};
export const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Espaces et sauts de ligne propres, sans changer le fond du texte. */
export function cleanText(t) {
  return String(t ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** PDF issus de LaTeX : l'accent est extrait seul, avant sa lettre (« al´ eatoires » → « aléatoires »). */
const ACCENTS = { '´': '\u0301', '`': '\u0300', 'ˆ': '\u0302', '¨': '\u0308', '˜': '\u0303', '¸': '\u0327' };
export function fixAccents(t) {
  return String(t ?? '').replace(/([´`ˆ¨˜¸]) ?(\p{L})/gu, (m, acc, letter) => (letter + ACCENTS[acc]).normalize('NFC'));
}

let pdfjs = null;
async function loadPdf() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}
let mammothPromise = null;
function loadMammoth() {
  if (globalThis.mammoth) return Promise.resolve(globalThis.mammoth);
  mammothPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/mammoth.browser.min.js', import.meta.url).href;
    s.onload = () => resolve(globalThis.mammoth);
    s.onerror = () => { mammothPromise = null; reject(new Error('Lecteur Word indisponible.')); };
    document.head.appendChild(s);
  });
  return mammothPromise;
}

async function pdfText(buffer) {
  const lib = await loadPdf();
  let doc;
  try { doc = await lib.getDocument({ data: new Uint8Array(buffer) }).promise; }
  catch (e) { throw new Error(e?.name === 'PasswordException' ? 'Ce PDF est protégé par un mot de passe.' : 'PDF illisible.'); }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let line = '', text = '';
    for (const it of content.items) {
      line += it.str;
      if (it.hasEOL) { text += line + '\n'; line = ''; } else if (it.str && !/\s$/.test(it.str)) line += ' ';
    }
    text += line;
    if (text.trim()) pages.push(`[Page ${i}]\n${text}`);
  }
  doc.destroy();
  return pages.join('\n\n');
}

/** Renvoie { kind, text }. Lève une Error en français si le fichier n'est pas exploitable. */
export async function extractText(file) {
  const kind = kindOf(file.name, file.type);
  if (!kind) throw new Error('Format non pris en charge (PDF, Word .docx, .txt ou .md).');
  if (file.size > MAX_FILE_BYTES) throw new Error('Fichier trop volumineux (25 Mo maximum).');
  let raw;
  if (kind === 'text') raw = await file.text();
  else if (kind === 'pdf') raw = fixAccents(await pdfText(await file.arrayBuffer()));
  else {
    const mammoth = await loadMammoth();
    try { raw = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value; }
    catch { throw new Error('Document Word illisible.'); }
  }
  const text = cleanText(raw).slice(0, MAX_TEXT_CHARS);
  if (text.replace(/\[Page \d+\]/g, '').trim().length < 30) {
    throw new Error(kind === 'pdf' ? 'Aucun texte trouvé dans ce PDF (scan ou images ?). Utilise un PDF avec texte sélectionnable.' : 'Ce fichier ne contient presque pas de texte.');
  }
  return { kind, text };
}
