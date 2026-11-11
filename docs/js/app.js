/* Interface Révisions Campass — JS vanilla. Données et calculs dans le navigateur (voir backend.js). */
import { createBackend } from './backend.js';
import { Store } from './store.js';
import { openLibrary, fold } from './library.js';
import { extractText, kindOf, ACCEPT } from './extract.js';
import * as AI from './ai.js';
import { mdToHtml } from './md.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const hhmm = s => s.slice(11, 16);
const mins = s => +s.slice(11, 13) * 60 + +s.slice(14, 16);
const fmtLong = d => parseDay(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = d => parseDay(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}` : `${m} min`;
const monday = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

let view = 'dashboard';
let param = null;                     // paramètre de la vue : nom de matière ou id de cours
let weekStart = monday(new Date());

const store = new Store();
const backend = await createBackend({ store, cfg: { autoRefreshMinutes: 60 } });
const library = await openLibrary();
const api = (path, opts = {}) => backend.handle(opts.method || 'GET', path, opts.json);

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm text-white shadow-lg ${ok ? 'bg-emerald-600' : 'bg-red-600'}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, false); } };

/* ---------------------------------------------------------------- composants */
function gauge(load) {
  const l = load || { minutes: 0, capacity: 180, ratio: 0, level: 'ok', done_minutes: 0 };
  const color = { ok: '#16a34a', warn: '#ea580c', over: '#dc2626' }[l.level];
  const pct = Math.min(100, Math.round(l.ratio * 100));
  const label = { ok: 'Charge raisonnable', warn: 'Journée chargée', over: 'Surcharge !' }[l.level];
  return `<div class="h-3 bg-slate-100 rounded-full overflow-hidden"><div style="width:${pct}%;background:${color}" class="h-full"></div></div>
    <p class="text-xs mt-1.5 text-slate-500"><b style="color:${color}">${label}</b> · ${fmtDur(l.minutes)} / ${fmtDur(l.capacity)}
    ${l.minutes ? ` · fait : ${fmtDur(l.done_minutes)}` : ''}</p>`;
}

function badges(s) {
  return [
    s.catchup ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">rattrapage</span>' : '',
    s.overdue ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">en retard</span>' : '',
    s.overloaded ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">chevauchement / journée pleine</span>' : '',
    s.moved ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">déplacé</span>' : '',
    s.custom_minutes ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">durée perso</span>' : '',
  ].join(' ');
}

function statusButtons(s) {
  const id = esc(s.id);
  if (s.status === 'pending') {
    return `<div class="flex gap-1 shrink-0">
      <button data-status="done" data-sid="${id}" class="px-2 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700">✓ Fait</button>
      <button data-status="missed" data-sid="${id}" class="px-2 py-1 text-xs rounded-md border border-red-300 text-red-700 hover:bg-red-50">✗ Non fait</button></div>`;
  }
  const done = s.status === 'done';
  return `<div class="flex items-center gap-2 shrink-0">
    <span class="text-xs ${done ? 'text-emerald-700' : 'text-red-700'}">${done ? '✓ Fait' : '✗ Non fait · reporté'}</span>
    <button data-status="pending" data-sid="${id}" class="text-xs text-slate-500 underline">Annuler</button></div>`;
}

function sessionRow(s, withDay = false) {
  const chap = s.chapters.length ? ` · chap. ${s.chapters[0]}${s.chapters.length > 1 ? '–' + s.chapters[s.chapters.length - 1] : ''}` : '';
  const part = s.catchup ? ' · rattrapage' : (s.slot_count > 1 ? ` (${s.slot_index + 1}/${s.slot_count})` : '');
  const tone = s.status === 'done' ? 'opacity-60' : s.status === 'missed' ? 'bg-red-50' : 'bg-white';
  return `<li class="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-slate-200 ${tone}" style="border-left:5px solid ${esc(s.color)}">
    <div class="flex-1 min-w-[12rem]">
      <p class="font-medium ${s.status === 'done' ? 'line-through' : ''}">${esc(s.subject)}${part} ${badges(s)}</p>
      <p class="text-xs text-slate-500">${withDay ? fmtShort(s.day) + ' · ' : ''}${hhmm(s.start)}–${hhmm(s.end)} (${fmtDur(s.minutes)})${chap} · prépare le cours du ${fmtShort(s.target.slice(0, 10))}</p>
    </div>
    ${statusButtons(s)}
    ${s.status === 'pending' ? `<button data-move="${esc(s.id)}" class="text-xs text-slate-500 hover:text-slate-900 underline shrink-0">Modifier</button>` : ''}
  </li>`;
}

let sessionIndex = {};
function bindSessionActions(root) {
  $$('[data-status]', root).forEach(b => b.onclick = guard(async () => {
    const r = await api(`/api/sessions/${b.dataset.sid}`, { method: 'PATCH', json: { status: b.dataset.status } });
    if (b.dataset.status === 'missed') toast(`Reporté au cycle suivant · retard de la matière : ${r.backlog}`);
    await refresh();
  }));
  $$('[data-move]', root).forEach(b => b.onclick = () => openMove(sessionIndex[b.dataset.move]));
}
const index = list => list.forEach(s => sessionIndex[s.id] = s);

/* ---------------------------------------------------------------- déplacement */
let moving = null;
function openMove(s) {
  if (!s) return;
  moving = s;
  $('#move-title').textContent = `Modifier « ${s.subject} »`;
  $('#move-day').value = s.day;
  $('#move-start').value = hhmm(s.start);
  $('#move-minutes').value = s.minutes;
  $('#move-dialog').showModal();
}
$('#move-cancel').onclick = () => $('#move-dialog').close();
$('#move-form').onsubmit = guard(async () => {
  const json = { day: $('#move-day').value, start: $('#move-start').value };
  const minutes = Number($('#move-minutes').value);
  if (minutes !== moving.minutes) json.minutes = minutes;            // durée propre à ce créneau uniquement
  await api(`/api/sessions/${moving.id}`, { method: 'PATCH', json });
  toast('Créneau modifié'); await refresh();
});
$('#move-default-minutes').onclick = guard(async () => {
  await api(`/api/sessions/${moving.id}`, { method: 'PATCH', json: { minutes: null } });
  $('#move-dialog').close(); toast('Durée de la matière rétablie'); await refresh();
});
$('#move-reset').onclick = guard(async () => {
  await api(`/api/sessions/${moving.id}`, { method: 'PATCH', json: { reset: true } });
  $('#move-dialog').close(); toast('Replanifié automatiquement'); await refresh();
});

/* ---------------------------------------------------------------- tableau de bord */
async function loadDashboard() {
  const [t, w, subs] = await Promise.all([api('/api/today'), api(`/api/week?start=${iso(monday(new Date()))}`), api('/api/subjects')]);
  $('#today-date').textContent = fmtLong(t.date);
  index(t.todo); index(t.upcoming);
  $('#todo-list').innerHTML = t.todo.length ? t.todo.map(s => sessionRow(s)).join('')
    : '<li class="text-sm text-slate-500 p-3">🎉 Rien à réviser aujourd\'hui. Importez votre emploi du temps si c\'est inattendu.</li>';
  $('#today-gauge').innerHTML = gauge(t.load);
  const indebted = subs.filter(x => x.backlog > 0);
  $('#debt-list').innerHTML = indebted.length ? indebted.map(x =>
    `<li class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full" style="background:${esc(x.color)}"></span>${esc(x.name)}
     <span class="ml-auto font-medium text-red-600">${x.backlog} · ${fmtDur(x.debt_minutes)}</span></li>`).join('')
    : '<li class="text-slate-400">Aucun retard 🎉</li>';
  $('#upcoming').innerHTML = t.upcoming.length ? t.upcoming.map(s =>
    `<li class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full" style="background:${esc(s.color)}"></span>${esc(s.subject)} <span class="text-slate-400 ml-auto">${fmtShort(s.day)}</span></li>`).join('')
    : '<li class="text-slate-400">Aucune</li>';
  bindSessionActions($('#view-dashboard'));
  renderMiniWeek(w);
}

function renderMiniWeek(w) {
  const start = parseDay(w.start);
  const cells = [...Array(7)].map((_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const k = iso(d);
    const ss = w.sessions.filter(s => s.day === k);
    const cs = w.courses.filter(c => c.start.slice(0, 10) === k);
    return `<div class="border rounded-lg p-2 min-h-[110px] ${k === iso(new Date()) ? 'border-slate-900' : 'border-slate-200'}">
      <p class="text-xs font-medium mb-1 capitalize">${fmtShort(k)}</p>
      ${cs.map(c => `<p class="text-[11px] truncate" style="color:${esc(c.color)}">● ${esc(c.subject)}</p>`).join('')}
      ${ss.map(s => `<p class="text-[11px] truncate font-medium ${s.done ? 'line-through opacity-50' : ''}" style="color:${esc(s.color)}">✎ ${esc(s.subject)}</p>`).join('')}
      <div class="mt-2">${gauge(w.load[k]).split('<p')[0]}</div></div>`;
  });
  $('#mini-week').innerHTML = `<div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">${cells.join('')}</div>
    <p class="text-xs text-slate-500 mt-2">● cours · ✎ révision</p>`;
}

/* ---------------------------------------------------------------- calendrier */
const HOUR_PX = 48;
async function loadCalendar() {
  const w = await api(`/api/week?start=${iso(weekStart)}`);
  index(w.sessions);
  const end = new Date(weekStart); end.setDate(end.getDate() + 6);
  $('#week-title').textContent = `${weekStart.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} – ${end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const hours = w.day_end - w.day_start;
  const axis = [...Array(hours)].map((_, i) => `<div class="hour-line text-[10px] text-slate-400 pr-1 text-right" style="height:${HOUR_PX}px">${pad(w.day_start + i)}h</div>`).join('');
  let head = '<div></div>', cols = `<div>${axis}</div>`;
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    const k = iso(d), today = k === iso(new Date());
    head += `<div class="p-2 border-l border-slate-200 ${today ? 'bg-slate-900 text-white' : ''}"><p class="text-sm font-medium capitalize">${fmtShort(k)}</p><div class="${today ? 'opacity-90' : ''}">${gauge(w.load[k]).split('<p')[0]}</div></div>`;
    const ev = [];
    w.courses.filter(c => c.start.slice(0, 10) === k).forEach(c => {
      const top = (mins(c.start) - w.day_start * 60) / 60 * HOUR_PX, h = Math.max(18, (mins(c.end) - mins(c.start)) / 60 * HOUR_PX);
      ev.push(`<div class="ev" style="top:${top}px;height:${h}px;background:${esc(c.color)}22;border-left:4px solid ${esc(c.color)}" title="${esc(c.summary)}">
        <b>${esc(c.subject)}</b> ${esc(c.kind)}<br>${hhmm(c.start)}–${hhmm(c.end)}${c.room ? ' · ' + esc(c.room) : ''}</div>`);
    });
    w.blocks.filter(b => b.day === k).forEach(b => {
      const top = ((+b.start.slice(0, 2)) * 60 + +b.start.slice(3) - w.day_start * 60) / 60 * HOUR_PX;
      const h = ((+b.end.slice(0, 2)) * 60 + +b.end.slice(3) - (+b.start.slice(0, 2)) * 60 - +b.start.slice(3)) / 60 * HOUR_PX;
      ev.push(`<div class="ev bg-slate-200 text-slate-600 ${b.recurring ? 'recurring-block' : ''}" style="top:${top}px;height:${h}px" title="${b.recurring ? 'Blocage hebdomadaire' : 'Blocage'}">${b.recurring ? '🔁' : '⛔'} ${esc(b.label || 'Bloqué')}</div>`);
    });
    w.sessions.filter(s => s.day === k).forEach(s => {
      const top = (mins(s.start) - w.day_start * 60) / 60 * HOUR_PX, h = Math.max(20, s.minutes / 60 * HOUR_PX);
      const acts = s.status === 'pending'
        ? `<button class="mini" data-status="done" data-sid="${esc(s.id)}" title="Fait">✓</button> <button class="mini" data-status="missed" data-sid="${esc(s.id)}" title="Non fait">✗</button> <button class="mini" data-move="${esc(s.id)}" title="Déplacer">⇄</button>`
        : `<button class="mini" data-status="pending" data-sid="${esc(s.id)}" title="Annuler">↩</button>`;
      ev.push(`<div class="ev rev ${s.status}" draggable="true" data-sid="${esc(s.id)}" style="top:${top}px;height:${h}px;border-color:${esc(s.color)};color:${esc(s.color)}">
        <b>${s.catchup ? '↻' : '✎'} ${esc(s.subject)}</b>${s.overloaded ? ' ⚠️' : ''}<br>${hhmm(s.start)}–${hhmm(s.end)} ${acts}</div>`);
    });
    cols += `<div class="week-grid border-l border-slate-200" data-day="${k}" style="height:${hours * HOUR_PX}px;background-image:repeating-linear-gradient(to bottom,#e2e8f0 0,#e2e8f0 1px,transparent 1px,transparent ${HOUR_PX}px)">${ev.join('')}</div>`;
  }
  $('#calendar').innerHTML = `<div class="grid" style="grid-template-columns:44px repeat(7,1fr)">${head}</div>
    <div class="grid" style="grid-template-columns:44px repeat(7,1fr)">${cols}</div>`;
  bindSessionActions($('#calendar'));
  bindDrag(w.day_start);
}

function bindDrag(dayStart) {
  $$('#calendar .rev').forEach(el => {
    el.ondragstart = e => { e.dataTransfer.setData('text/plain', el.dataset.sid); e.dataTransfer.effectAllowed = 'move'; };
    el.ondblclick = () => openMove(sessionIndex[el.dataset.sid]);
  });
  $$('#calendar .week-grid').forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add('drop-hover'); };
    col.ondragleave = () => col.classList.remove('drop-hover');
    col.ondrop = guard(async e => {
      e.preventDefault(); col.classList.remove('drop-hover');
      const sid = e.dataTransfer.getData('text/plain');
      if (!sid) return;
      const y = e.clientY - col.getBoundingClientRect().top;
      const total = Math.round((dayStart * 60 + y / HOUR_PX * 60) / 15) * 15;
      const start = `${pad(Math.min(23, Math.floor(total / 60)))}:${pad(total % 60)}`;
      await api(`/api/sessions/${sid}`, { method: 'PATCH', json: { day: col.dataset.day, start } });
      toast('Créneau déplacé'); await refresh();
    });
  });
}
$('#prev-week').onclick = () => { weekStart.setDate(weekStart.getDate() - 7); refresh(); };
$('#next-week').onclick = () => { weekStart.setDate(weekStart.getDate() + 7); refresh(); };
$('#this-week').onclick = () => { weekStart = monday(new Date()); refresh(); };

/* ---------------------------------------------------------------- agenda */
async function loadAgenda() {
  const a = await api('/api/agenda');
  index(a.sessions);
  const byDay = {};
  a.sessions.forEach(s => (byDay[s.day] ||= []).push(s));
  const days = Object.keys(byDay).sort();
  $('#agenda-list').innerHTML = days.length ? days.map(k => `<div>
      <div class="flex items-center gap-3 mb-2"><h3 class="font-medium capitalize ${k === iso(new Date()) ? 'text-blue-600' : ''}">${fmtLong(k)}</h3>
      <div class="w-40">${gauge(a.load[k])}</div></div>
      <ul class="space-y-2">${byDay[k].map(s => sessionRow(s)).join('')}</ul></div>`).join('')
    : '<p class="text-slate-500">Aucune révision planifiée. Importez votre emploi du temps.</p>';
  bindSessionActions($('#agenda-list'));
}

/* ---------------------------------------------------------------- matières */
function subjectSummary(s) {
  const base = `→ ${s.slots} créneau${s.slots > 1 ? 'x' : ''} de ${fmtDur(s.slot_minutes)} (${fmtDur(s.total_minutes)} par cours)`;
  return s.backlog ? `${base} + ${s.backlog} rattrapage${s.backlog > 1 ? 's' : ''} (${fmtDur(s.debt_minutes)} de dette)` : base;
}
async function loadSubjects() {
  const [list, counts] = await Promise.all([api('/api/subjects'), library.counts()]);
  const num = (name, label, v, min, max, step) => `<label class="text-xs text-slate-600">${label}
    <input type="number" data-f="${name}" value="${v}" min="${min}" max="${max}" step="${step}" class="w-full border rounded-lg px-2 py-1 text-sm mt-0.5"></label>`;
  $('#subjects-list').innerHTML = list.length ? list.map(s => `<div class="bg-white rounded-xl border border-slate-200 p-4" data-name="${esc(s.name)}">
    <div class="flex items-center gap-2 mb-3">
      <input type="color" data-f="color" value="${esc(s.color)}" class="w-7 h-7 rounded cursor-pointer border-0 p-0">
      <h3 class="font-medium flex-1 truncate"><button data-open="${esc(s.name)}" class="hover:underline text-left max-w-full truncate" title="Ouvrir les cours de cette matière">${esc(s.name)}</button></h3>
      <label class="text-xs flex items-center gap-1"><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> actif</label>
    </div>
    <div class="grid grid-cols-2 gap-3">
      ${num('session_minutes', 'Durée d\'une session (min)', s.session_minutes, 5, 480, 5)}
      ${num('intensity', 'Intensité (×)', s.intensity, 0.25, 5, 0.25)}
      ${num('chapters', 'Chapitres à revoir', s.chapters, 1, 60, 1)}
      ${num('chapters_per_session', 'Chapitres / session', s.chapters_per_session, 1, 30, 1)}
      ${num('backlog', 'Cours en retard (dette)', s.backlog, 0, 99, 1)}
    </div>
    <p class="text-sm font-medium mt-3 summary">${subjectSummary(s)}</p>
    <button data-open="${esc(s.name)}" class="mt-3 w-full text-sm border rounded-lg py-1.5 hover:bg-slate-50">📂 Mes cours${counts[fold(s.name)] ? ` (${counts[fold(s.name)]})` : ' — ajouter'}</button></div>`).join('')
    : '<p class="text-slate-500">Aucune matière : importez d\'abord votre emploi du temps.</p>';
  $$('#subjects-list [data-open]').forEach(b => b.onclick = () => show('subject', b.dataset.open));
  $$('#subjects-list [data-f]').forEach(inp => {
    inp.onchange = guard(async () => {
      const card = inp.closest('[data-name]');
      const body = { name: card.dataset.name, [inp.dataset.f]: inp.type === 'checkbox' ? inp.checked : inp.value };
      await api('/api/subjects', { method: 'PUT', json: body });
      const fresh = (await api('/api/subjects')).find(x => x.name === card.dataset.name);
      $('.summary', card).textContent = subjectSummary(fresh);
      toast('Agenda recalculé');
    });
  });
}

/* ---------------------------------------------------------------- import & sauvegarde */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

async function loadSync() {
  const s = await api('/api/settings');
  $('#ics-url').placeholder = s.ics_configured ? `Lien enregistré : ${s.ics_url_masked} (laisser vide pour le conserver)` : 'https://… ou webcal://…';
  $('#sync-detail').textContent = s.last_sync
    ? `Dernière importation : ${new Date(s.last_sync).toLocaleString('fr-FR')} (${s.last_sync_count} cours).${s.last_error ? ' ⚠️ ' + s.last_error : ''}`
    : 'Aucun emploi du temps importé pour le moment.';
  const warn = $('#storage-warning');
  warn.classList.toggle('hidden', s.persistent);
  warn.textContent = s.persistent ? '' : '⚠️ Le stockage de ce navigateur est bloqué (navigation privée ?) : tes données seront perdues à la fermeture de la page. Exporte-les avant de quitter.';
  $('#install-hint').classList.toggle('hidden', !(isIOS && !standalone));
  const blocks = await api('/api/blocks');
  $('#blocks-list').innerHTML = blocks.length ? blocks.map(b => `<li class="flex items-center gap-2">⛔ ${fmtShort(b.day)} ${esc(b.start)}–${esc(b.end)} ${esc(b.label)}
    <button data-del="${b.id}" class="ml-auto text-red-600 hover:underline text-xs">Supprimer</button></li>`).join('') : '<li class="text-slate-400">Aucun blocage.</li>';
  $$('#blocks-list [data-del]').forEach(b => b.onclick = guard(async () => { await api(`/api/blocks/${b.dataset.del}`, { method: 'DELETE' }); await loadSync(); }));

  const rblocks = await api('/api/recurring-blocks');
  $('#rblocks-list').innerHTML = rblocks.length ? rblocks.map(b => `<li class="flex items-center gap-2">🔁 ${esc(daysLabel(b.weekdays))} ${esc(b.start)}–${esc(b.end)} ${esc(b.label)}
    <span class="text-xs text-slate-400">${esc(rangeLabel(b.from, b.until))}</span>
    <button data-del="${b.id}" class="ml-auto text-red-600 hover:underline text-xs">Supprimer</button></li>`).join('') : '<li class="text-slate-400">Aucun blocage hebdomadaire.</li>';
  $$('#rblocks-list [data-del]').forEach(b => b.onclick = guard(async () => { await api(`/api/recurring-blocks/${b.dataset.del}`, { method: 'DELETE' }); await loadSync(); }));

  const courses = await api('/api/custom-courses');
  $('#courses-list').innerHTML = courses.length ? courses.map(c => `<li class="flex items-center gap-2">📘 <b>${esc(c.subject)}</b> ${esc(c.kind)} ${esc(c.start)}–${esc(c.end)}
    <span class="text-xs text-slate-500">${esc(courseFreq(c))}</span>
    <button data-del="${c.id}" class="ml-auto text-red-600 hover:underline text-xs">Supprimer</button></li>`).join('') : '<li class="text-slate-400">Aucun cours ajouté.</li>';
  $$('#courses-list [data-del]').forEach(b => b.onclick = guard(async () => { await api(`/api/custom-courses/${b.dataset.del}`, { method: 'DELETE' }); await loadSync(); }));
}

const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const daysLabel = wd => wd.length === 7 ? 'tous les jours' : 'chaque ' + wd.map(d => DAY_NAMES[d]).join(', ');
const shortDate = d => parseDay(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const rangeLabel = (from, until) => from && until ? `du ${shortDate(from)} au ${shortDate(until)}` : from ? `depuis le ${shortDate(from)}`
  : until ? `jusqu'au ${shortDate(until)}` : 'toute la période';
const courseFreq = c => c.frequency === 'once' ? `le ${shortDate(c.from)} (une fois)`
  : `${c.every === 1 ? 'chaque semaine' : `toutes les ${c.every} semaines`} · ${c.weekdays.map(d => DAY_NAMES[d].slice(0, 3)).join(', ')} · ${rangeLabel(c.from, c.until)}`;
const formBody = form => {
  const fd = new FormData(form), out = Object.fromEntries(fd);
  out.weekdays = fd.getAll('weekdays');
  return out;
};

const MAX_FILE = 6 * 1024 * 1024;
async function readFile(file) {
  if (file.size > MAX_FILE) throw new Error('Fichier trop volumineux.');
  return file.text();
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const imported = r => `${r.count} cours importés (${r.subjects} matière${r.subjects > 1 ? 's' : ''})`;

$('#btn-sync').onclick = guard(async () => {
  const r = await api('/api/sync', { method: 'POST', json: { url: $('#ics-url').value.trim() } });
  $('#ics-url').value = '';
  toast(imported(r)); await refresh();
});
$('#ics-file').onchange = guard(async e => {
  const f = e.target.files[0]; if (!f) return;
  const text = await readFile(f);
  e.target.value = '';
  toast(imported(await api('/api/upload', { method: 'POST', json: { text } }))); await refresh();
});
$('#btn-export').onclick = guard(async () => {
  const { text } = await api('/api/export');
  download(`revisions-campass-${iso(new Date())}.json`, text);
  toast('Sauvegarde exportée');
});
$('#import-file').onchange = guard(async e => {
  const f = e.target.files[0]; if (!f) return;
  const text = await readFile(f);
  e.target.value = '';
  if (!confirm('Remplacer toutes les données de cet appareil par cette sauvegarde ?')) return;
  await api('/api/import', { method: 'POST', json: { text } });
  toast('Sauvegarde restaurée'); await refresh();
});
$('#btn-reset').onclick = guard(async () => {
  if (!confirm('Effacer toutes les données de cet appareil (planning, cours téléversés, clé de l\'assistant) ? Pense à exporter une sauvegarde avant.')) return;
  await api('/api/reset', { method: 'POST' });
  await library.clear(); AI.clearSettings();
  toast('Données effacées'); await refresh();
});
$('#rblock-form').onsubmit = guard(async e => {
  e.preventDefault();
  await api('/api/recurring-blocks', { method: 'POST', json: formBody(e.target) });
  e.target.reset(); toast('Blocage hebdomadaire ajouté'); await loadSync();
});
const syncCourseForm = () => {
  const once = $('#course-freq').value === 'once';
  ['#course-every-wrap', '#course-until-wrap', '#course-days-wrap'].forEach(id => $(id).classList.toggle('hidden', once));
  $('#course-from-label').textContent = once ? 'Date' : 'À partir du';
};
$('#course-freq').onchange = syncCourseForm;
syncCourseForm();
$('#course-form').onsubmit = guard(async e => {
  e.preventDefault();
  const r = await api('/api/custom-courses', { method: 'POST', json: formBody(e.target) });
  e.target.reset(); syncCourseForm();
  toast(`Cours ajouté (${r.occurrences} séance${r.occurrences > 1 ? 's' : ''})`); await loadSync();
});
$('#block-form').onsubmit = guard(async e => {
  e.preventDefault();
  await api('/api/blocks', { method: 'POST', json: Object.fromEntries(new FormData(e.target)) });
  e.target.reset(); toast('Blocage ajouté'); await loadSync();
});

/* ---------------------------------------------------------------- cours d'une matière */
const KIND_ICON = { pdf: '📕', docx: '📘', text: '📝' };
const fmtSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`;
let currentSubject = null;

async function loadSubject(name) {
  const subs = await api('/api/subjects');
  const s = subs.find(x => fold(x.name) === fold(name));
  if (!s) return show('subjects');
  currentSubject = s;
  $('#subj-dot').style.background = s.color;
  $('#subj-title').textContent = s.name;
  $('#lib-warning').classList.toggle('hidden', library.persistent);
  const docs = await library.list(s.name);
  $('#docs-list').innerHTML = docs.length ? docs.map(d => `<li class="flex items-center gap-3 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-400" style="border-left:5px solid ${esc(s.color)}">
      <button data-doc="${d.id}" class="flex-1 min-w-0 text-left">
        <p class="font-medium truncate">${KIND_ICON[d.kind] || '📄'} ${esc(d.name)} ${d.has_summary ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 align-middle">✨ résumé</span>' : ''}</p>
        <p class="text-xs text-slate-500">${fmtSize(d.size)} · ajouté le ${new Date(d.added).toLocaleDateString('fr-FR')}${d.messages ? ` · ${d.messages} message${d.messages > 1 ? 's' : ''}` : ''}</p>
      </button>
      <button data-rm="${d.id}" data-name="${esc(d.name)}" class="text-xs text-red-600 hover:underline shrink-0">Supprimer</button></li>`).join('')
    : '<li class="text-sm text-slate-400 p-2">Aucun cours pour le moment. Ajoute ton premier fichier ci-dessus.</li>';
  $$('#docs-list [data-doc]').forEach(b => b.onclick = () => show('doc', b.dataset.doc));
  $$('#docs-list [data-rm]').forEach(b => b.onclick = guard(async () => {
    if (!confirm(`Supprimer « ${b.dataset.name} » de cet appareil ?`)) return;
    await library.remove(b.dataset.rm); toast('Cours supprimé'); await loadSubject(name);
  }));
}

async function uploadFiles(files) {
  if (!currentSubject) return;
  const zone = $('#dropzone'), label = $('#drop-label'), errors = [];
  let added = 0;
  zone.classList.add('busy');
  try {
    for (const f of files) {
      label.textContent = `Lecture de ${f.name}…`;
      try {
        const { kind, text } = await extractText(f);
        await library.add({ subject: currentSubject.name, name: f.name, kind, size: f.size, text, blob: f });
        added++;
      } catch (e) { errors.push(`${f.name} : ${e.message}`); }
    }
  } finally { zone.classList.remove('busy'); label.textContent = 'Ajouter des cours'; }
  if (added) toast(`${added} cours ajouté${added > 1 ? 's' : ''}${errors.length ? ` · ${errors.length} refusé${errors.length > 1 ? 's' : ''}` : ''}`);
  if (errors.length) toast(errors.join('\n'), false);
  await loadSubject(currentSubject.name);
}
$('#doc-file').accept = ACCEPT;
$('#doc-file').onchange = guard(async e => { const f = [...e.target.files]; e.target.value = ''; await uploadFiles(f); });
{
  const z = $('#dropzone');
  ['dragenter', 'dragover'].forEach(t => z.addEventListener(t, e => { e.preventDefault(); z.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => z.addEventListener(t, e => { e.preventDefault(); z.classList.remove('over'); }));
  z.addEventListener('drop', guard(async e => { await uploadFiles([...e.dataTransfer.files]); }));
}

/* ---------------------------------------------------------------- lecture d'un cours + assistant */
let doc = null, aiBusy = false, docToken = 0;
let aiSettings = AI.loadSettings();

function renderReader(text) {
  const parts = text.split(/\n*\[Page (\d+)\]\n/);                 // [avant, n°, texte, n°, texte…]
  const para = t => t.split(/\n{2,}/).filter(x => x.trim()).map(x => `<p>${esc(x.trim())}</p>`).join('');
  let html = parts[0].trim() ? para(parts[0]) : '';
  for (let i = 1; i < parts.length; i += 2) html += `<div class="page-mark">Page ${esc(parts[i])}</div>${para(parts[i + 1] || '')}`;
  $('#doc-text').innerHTML = html;
}

const scrollChat = () => { const b = $('#ai-scroll'); b.scrollTop = b.scrollHeight; };
function renderChat() {
  $('#ai-chat').innerHTML = doc.chat.map(m => m.role === 'user'
    ? `<div class="bubble bubble-user">${esc(m.content)}</div>` : `<div class="bubble bubble-ai ai-md">${mdToHtml(m.content)}</div>`).join('');
  $('#ai-suggest').innerHTML = doc.chat.length ? '' : AI.SUGGESTIONS.map(q => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  $$('#ai-suggest [data-q]').forEach(b => b.onclick = () => sendQuestion(b.dataset.q));
}
const typing = on => {
  $('#ai-chat').querySelector('.typing-row')?.remove();
  if (on) $('#ai-chat').insertAdjacentHTML('beforeend', '<div class="bubble bubble-ai typing-row"><span class="typing"><span></span><span></span><span></span></span></div>');
  scrollChat();
};
const errBubble = msg => { $('#ai-chat').insertAdjacentHTML('beforeend', `<div class="bubble bubble-err" role="alert">${esc(msg)}</div>`); scrollChat(); };
const aiConfig = () => AI.activeConfig(aiSettings);
const aiContext = () => AI.systemPrompt({ subject: doc.subject_name, title: doc.name, text: doc.text });

function renderSummary(state, msg = '') {
  const el = $('#ai-summary'), btn = $('#ai-resum');
  btn.classList.toggle('hidden', !(doc && doc.summary) || aiBusy);
  if (state === 'ready') el.innerHTML = mdToHtml(doc.summary);
  else if (state === 'loading') el.innerHTML = '<span class="typing"><span></span><span></span><span></span></span> <span class="text-slate-500">Lecture du cours…</span>';
  else if (state === 'nokey') el.innerHTML = `<p class="text-slate-600">Ajoute ta clé API pour obtenir un résumé du cours et poser tes questions.</p>
      <button type="button" data-config class="mt-2 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-sm">Configurer l'assistant</button>`;
  else el.innerHTML = `<p class="text-red-700" role="alert">${esc(msg)}</p><button type="button" data-retry class="mt-2 px-3 py-1.5 border rounded-lg text-sm">Réessayer</button>`;
  $('[data-config]', el)?.addEventListener('click', openAiSettings);
  $('[data-retry]', el)?.addEventListener('click', () => summarize());
}

async function summarize() {
  const cfg = aiConfig(), token = docToken;
  if (!cfg.key) return renderSummary('nokey');
  aiBusy = true; renderSummary('loading');
  try {
    const text = await AI.ask(cfg, { system: aiContext(), messages: [{ role: 'user', content: AI.SUMMARY_REQUEST }] });
    if (token !== docToken) return;
    doc.summary = text;
    await library.update(doc.id, { summary: text });
    aiBusy = false; renderSummary('ready');
  } catch (e) {
    if (token !== docToken) return;
    aiBusy = false; renderSummary('error', e.message);
    if (e.code === 'auth') openAiSettings();
  } finally { if (token === docToken) aiBusy = false; }
}
$('#ai-resum').onclick = () => { if (!aiBusy) summarize(); };

async function sendQuestion(text) {
  text = String(text || '').trim();
  if (!text || aiBusy || !doc) return;
  const cfg = aiConfig(), token = docToken;
  if (!cfg.key) return openAiSettings();
  aiBusy = true; $('#ai-send').disabled = true;
  doc.chat.push({ role: 'user', content: text });
  renderChat(); typing(true);
  try {
    const answer = await AI.ask(cfg, { system: aiContext(), messages: doc.chat });
    if (token !== docToken) return;
    doc.chat.push({ role: 'assistant', content: answer });
    doc.chat = doc.chat.slice(-60);
    await library.update(doc.id, { chat: doc.chat });
    $('#ai-input').value = ''; autosize();
    renderChat();
  } catch (e) {
    if (token !== docToken) return;
    doc.chat.pop();                                        // la question n'a pas abouti : on pourra la renvoyer telle quelle
    renderChat(); $('#ai-input').value = text; autosize(); errBubble(e.message);
    if (e.code === 'auth' || e.code === 'nokey') openAiSettings();
  } finally {
    if (token === docToken) { aiBusy = false; $('#ai-send').disabled = false; typing(false); renderSummary(doc.summary ? 'ready' : 'nokey'); scrollChat(); }
  }
}
const autosize = () => { const t = $('#ai-input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; };
$('#ai-input').oninput = autosize;
$('#ai-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendQuestion(e.target.value); } };
$('#ai-form').onsubmit = e => { e.preventDefault(); sendQuestion($('#ai-input').value); };

async function loadDoc(id) {
  const d = await library.get(id);
  if (!d) { toast('Cours introuvable', false); return show('subjects'); }
  docToken++; doc = d; aiBusy = false; $('#ai-send').disabled = false;
  aiSettings = AI.loadSettings();
  $('#doc-title').textContent = d.name;
  $('#doc-sub').textContent = `${d.subject_name} · ${fmtSize(d.size)} · ${d.text.length.toLocaleString('fr-FR')} caractères`;
  $('#doc-back-label').textContent = d.subject_name;
  $('#doc-original').classList.toggle('hidden', !d.blob);
  $('#ai-model').textContent = aiConfig().key ? aiConfig().model : '';
  renderReader(d.text); renderChat();
  window.scrollTo({ top: 0 });
  if (d.summary) renderSummary('ready'); else summarize();
}
$('#doc-back').onclick = () => show('subject', doc ? doc.subject_name : '');
$('#doc-original').onclick = () => {
  if (!doc || !doc.blob) return;
  const url = URL.createObjectURL(doc.blob);
  if (doc.kind === 'pdf') window.open(url, '_blank', 'noopener');
  else { const a = Object.assign(document.createElement('a'), { href: url, download: doc.name }); document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

/* ---- réglages de l'assistant */
function fillAiForm() {
  const prov = $('#ai-provider').value;
  $('#ai-key').value = aiSettings.keys[prov] || '';
  $('#ai-model-input').value = aiSettings.models[prov] || '';
  $('#ai-model-input').placeholder = AI.PROVIDERS[prov].model;
  $('#ai-help').href = AI.PROVIDERS[prov].help;
}
function openAiSettings() {
  aiSettings = AI.loadSettings();
  $('#ai-provider').innerHTML = Object.entries(AI.PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#ai-provider').value = aiSettings.provider;
  fillAiForm();
  if (!$('#ai-dialog').open) $('#ai-dialog').showModal();
}
$('#ai-provider').onchange = fillAiForm;
$('#ai-settings').onclick = openAiSettings;
$('#ai-cancel').onclick = () => $('#ai-dialog').close();
$('#ai-clear').onclick = () => {
  const prov = $('#ai-provider').value;
  aiSettings.keys[prov] = ''; AI.saveSettings(aiSettings); $('#ai-key').value = '';
  toast('Clé supprimée de cet appareil');
};
$('#ai-config-form').onsubmit = () => {
  const prov = $('#ai-provider').value;
  aiSettings.provider = prov;
  aiSettings.keys[prov] = $('#ai-key').value.trim();
  aiSettings.models[prov] = $('#ai-model-input').value.trim();
  if (!AI.saveSettings(aiSettings)) toast('Impossible d\'enregistrer les réglages dans ce navigateur.', false);
  else toast('Assistant configuré');
  if (view === 'doc' && doc) {
    $('#ai-model').textContent = aiConfig().key ? aiConfig().model : '';
    if (!doc.summary && !aiBusy) summarize();
  }
};

/* ---------------------------------------------------------------- navigation */
async function refreshStatus() {
  const s = await api('/api/settings');
  $('#sync-status').textContent = s.last_sync ? `Sync : ${new Date(s.last_sync).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Pas encore synchronisé';
}
const loaders = { dashboard: loadDashboard, calendar: loadCalendar, agenda: loadAgenda, subjects: loadSubjects, sync: loadSync,
                  subject: loadSubject, doc: loadDoc };
const NAV_OF = { subject: 'subjects', doc: 'subjects' };           // pages « enfants » : on garde « Matières » allumé
const refresh = guard(async () => { await loaders[view](param); refreshStatus(); });
function show(v, p = null) {
  view = loaders[v] ? v : 'dashboard';
  param = (view === 'subject' || view === 'doc') && p != null && p !== '' ? String(p) : null;
  if ((view === 'subject' || view === 'doc') && param === null) view = 'subjects';
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== `view-${view}`));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === (NAV_OF[view] || view)));
  $('main').classList.toggle('max-w-6xl', view !== 'doc');          // le lecteur utilise toute la largeur
  history.replaceState(null, '', `#${view}${param !== null ? '/' + encodeURIComponent(param) : ''}`);
  refresh();
}
$$('[data-view]').forEach(b => b.onclick = () => show(b.dataset.view));
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
await backend.autoSync();            // rafraîchit en silence si un lien est enregistré et ancien
{
  const [v, ...rest] = location.hash.slice(1).split('/');
  let p = null; try { p = decodeURIComponent(rest.join('/')); } catch { /* hash invalide */ }
  show(v || 'dashboard', p);
}
