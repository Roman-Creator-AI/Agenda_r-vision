// Extraction du texte des cours téléversés (PDF, Word .docx, texte / Markdown), entièrement dans le navigateur.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 1500000;

export const kindOf = (name, mime = '') => {
  const n = String(name).toLowerCase();
  if (n.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (n.endsWith('.docx') || mime.includes('wordprocessingml')) return 'docx';
  if (n.endsWith('.pptx') || mime.includes('presentationml.presentation')) return 'pptx';
  if (/\.(txt|md|markdown)$/.test(n) || mime.startsWith('text/')) return 'text';
  return null;
};
export const ACCEPT = '.pdf,.docx,.pptx,.txt,.md,.markdown,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation';

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
export async function getPdfjs() {
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
  const lib = await getPdfjs();
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

/* ------------------------------------------------------------ PowerPoint (.pptx = archive zip de XML) */
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = t => t.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] !== '#') return XML_ENT[e.toLowerCase()];
  const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  try { return String.fromCodePoint(c); } catch { return ''; }
});

/** Formes d'une diapositive, dans l'ordre : [{ ph: type de zone réservée | '', paras: [{ t, l }] }]. */
export function parseSlideXml(xml) {
  const shapes = [];
  for (const block of String(xml).match(/<p:sp\b[\s\S]*?<\/p:sp>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g) || []) {
    const ph = (block.match(/<p:ph\b[^>]*\btype="([^"]+)"/) || [])[1] || (/<p:ph\b/.test(block) ? 'body' : '');
    const paras = [];
    for (const p of block.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>|<a:p\s*\/>/g) || []) {
      const l = Number((p.match(/<a:pPr\b[^>]*\blvl="(\d)"/) || [])[1] || 0);
      const t = decodeXml(p.replace(/<a:br\s*\/?>/g, '<a:t> </a:t>').match(/<a:t\b[^>]*>[^<]*<\/a:t>|<a:t\s*\/>/g)
        ?.map(x => x.replace(/<[^>]+>/g, '')).join('') || '').replace(/\s+/g, ' ').trim();
      if (t) paras.push({ t, l: Math.min(l, 4) });
    }
    if (paras.length) shapes.push({ ph, paras });
  }
  return shapes;
}

const SKIP_PH = new Set(['sldNum', 'ftr', 'dt', 'hdr']);
/** Une diapositive en texte : titre, puces (indentées selon le niveau), puis notes du présentateur. */
export function slideToText(n, shapes, notesShapes = []) {
  const title = shapes.find(s => s.ph === 'title' || s.ph === 'ctrTitle');
  const lines = [`[Diapo ${n}]`];
  if (title) lines.push(title.paras.map(p => p.t).join(' '));
  for (const sh of shapes) {
    if (sh === title || SKIP_PH.has(sh.ph)) continue;
    for (const p of sh.paras) lines.push(`${'  '.repeat(p.l)}- ${p.t}`);
  }
  const notes = notesShapes.filter(s => s.ph === 'body').flatMap(s => s.paras.map(p => p.t)).join(' ');
  if (notes) lines.push(`Notes : ${notes}`);
  return lines.join('\n');
}

let zipPromise = null;
function loadJSZip() {
  if (globalThis.JSZip) return Promise.resolve(globalThis.JSZip);
  zipPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/jszip.min.js', import.meta.url).href;
    s.onload = () => resolve(globalThis.JSZip);
    s.onerror = () => { zipPromise = null; reject(new Error('Lecteur PowerPoint indisponible.')); };
    document.head.appendChild(s);
  });
  return zipPromise;
}

/** `zip` : objet JSZip déjà chargé. Renvoie le texte de toutes les diapositives, dans l'ordre de la présentation. */
export async function pptxText(zip) {
  const read = async path => { const f = zip.file(path); return f ? f.async('string') : ''; };
  const num = p => Number((p.match(/(\d+)\.xml$/) || [])[1] || 0);
  let slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error('Présentation PowerPoint illisible.');
  // ordre réel (l'utilisateur a pu réordonner les diapositives) : presentation.xml + ses relations
  try {
    const pres = await read('ppt/presentation.xml'), rels = await read('ppt/_rels/presentation.xml.rels');
    const target = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [
      (m[0].match(/\bId="([^"]+)"/) || [])[1], (m[0].match(/\bTarget="([^"]+)"/) || [])[1]]));
    const ordered = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
      .map(m => target[m[1]] && 'ppt/' + target[m[1]].replace(/^\/?(ppt\/)?/, '')).filter(p => slides.includes(p));
    if (ordered.length === slides.length) slides = ordered;
  } catch { /* on garde l'ordre numérique */ }
  const out = [];
  for (let i = 0; i < Math.min(slides.length, 500); i++) {
    const path = slides[i];
    const shapes = parseSlideXml(await read(path));
    let notes = [];
    const rels = await read(path.replace('slides/', 'slides/_rels/') + '.rels');
    const nt = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0])
      .find(r => /\/notesSlide"/.test(r))?.match(/\bTarget="([^"]+)"/)?.[1];
    if (nt) notes = parseSlideXml(await read('ppt/' + nt.replace(/^(\.\.\/)+/, '').replace(/^\/?(ppt\/)?/, '')));
    out.push(slideToText(i + 1, shapes, notes));
  }
  return out.join('\n\n');
}

/** Renvoie { kind, text }. Lève une Error en français si le fichier n'est pas exploitable. */
export async function extractText(file) {
  const kind = kindOf(file.name, file.type);
  if (!kind) {
    throw new Error(/\.(ppt|doc|key|pages|odp)$/i.test(file.name)
      ? 'Ancien format non pris en charge : enregistre-le en .pptx / .docx, ou exporte-le en PDF.'
      : 'Format non pris en charge (PDF, Word .docx, PowerPoint .pptx, .txt ou .md).');
  }
  if (file.size > MAX_FILE_BYTES) throw new Error('Fichier trop volumineux (25 Mo maximum).');
  let raw;
  if (kind === 'text') raw = await file.text();
  else if (kind === 'pdf') raw = fixAccents(await pdfText(await file.arrayBuffer()));
  else if (kind === 'pptx') {
    const JSZip = await loadJSZip();
    let zip;
    try { zip = await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new Error('Présentation PowerPoint illisible.'); }
    raw = await pptxText(zip);
  } else {
    const mammoth = await loadMammoth();
    try { raw = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value; }
    catch { throw new Error('Document Word illisible.'); }
  }
  const text = cleanText(raw).slice(0, MAX_TEXT_CHARS);
  if (text.replace(/\[(Page|Diapo) \d+\]/g, '').trim().length < 30) {
    throw new Error(kind === 'pdf' ? 'Aucun texte trouvé dans ce PDF (scan ou images ?). Utilise un PDF avec texte sélectionnable.' : 'Ce fichier ne contient presque pas de texte.');
  }
  return { kind, text };
}
