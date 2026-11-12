// Affichage visuel des pages d'un PDF (diapositives exportées de PowerPoint, schémas…) avec pdf.js.
// Les pages ne sont dessinées que lorsqu'elles approchent de l'écran, pour rester fluide sur téléphone.
import { getPdfjs } from './extract.js';

export async function openPdf(blob) {
  const lib = await getPdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const v = (await pdf.getPage(1)).getViewport({ scale: 1 });
  return { pdf, ratio: v.width / v.height, landscape: v.width > v.height * 1.15 };
}

/** Prépare une zone par page ; renvoie { destroy } à appeler en quittant le cours. */
export function mountPages(handle, root, label = 'Page') {
  const { pdf, ratio } = handle;
  root.textContent = '';
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); draw(e.target).catch(() => { e.target.classList.add('pdf-failed'); }); }
  }, { rootMargin: '900px 0px' });
  let dead = false;
  async function draw(box) {
    const page = await pdf.getPage(Number(box.dataset.i));
    if (dead) return;
    const v1 = page.getViewport({ scale: 1 });
    const css = box.clientWidth || 800, dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (css * dpr) / v1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${label} ${box.dataset.i}`);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (dead) return;
    box.style.aspectRatio = `${v1.width} / ${v1.height}`;
    box.replaceChildren(canvas);
  }
  for (let i = 1; i <= pdf.numPages; i++) {
    const wrap = document.createElement('figure');
    wrap.className = 'pdf-page-wrap';
    const box = document.createElement('div');
    box.className = 'pdf-page'; box.dataset.i = i; box.style.aspectRatio = String(ratio);
    const cap = document.createElement('figcaption');
    cap.textContent = `${label} ${i} / ${pdf.numPages}`;
    wrap.append(box, cap); root.append(wrap);
    io.observe(box);
  }
  return { destroy() { dead = true; io.disconnect(); try { pdf.destroy(); } catch { /* déjà détruit */ } } };
}
