// Rendu Markdown minimal et SÛR (tout est échappé d'abord) pour les réponses de l'assistant.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

/** Titres (#, ##, ###), listes (-, *, 1.), paragraphes, gras, italique, code. Aucun HTML brut n'est conservé. */
export function mdToHtml(text) {
  const out = [];
  let list = null;                                    // 'ul' | 'ol'
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); close(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush(); close();
      const lvl = Math.min(m[1].length + 2, 5);          // # -> h3 : l'assistant ne produit pas de h1/h2
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flush(); if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flush(); if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else { close(); para.push(line.trim()); }
  }
  flush(); close();
  return out.join('');
}
