/* Interface Révisions Campass — JS vanilla. Données et calculs dans le navigateur (voir backend.js). */
import { createBackend } from './backend.js';
import { Store } from './store.js';
import { openLibrary, fold } from './library.js';
import { extractText, kindOf, ACCEPT } from './extract.js';
import { openPdf, mountPages } from './pdfview.js';
import * as AI from './ai.js';
import * as SRS from './srs.js';
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

function sessionRow(s, withDay = false, draggable = false) {
  const chap = s.chapters.length ? ` · chap. ${s.chapters[0]}${s.chapters.length > 1 ? '–' + s.chapters[s.chapters.length - 1] : ''}` : '';
  const part = s.catchup ? ' · rattrapage' : (s.slot_count > 1 ? ` (${s.slot_index + 1}/${s.slot_count})` : '');
  const tone = s.status === 'done' ? 'opacity-60' : s.status === 'missed' ? 'bg-red-50' : 'bg-white';
  return `<li class="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-slate-200 ${tone}${draggable ? ' drag-card' : ''}" ${draggable ? `draggable="true" data-drag-sid="${esc(s.id)}" title="Glisse sur un autre jour pour déplacer"` : ''} style="border-left:5px solid ${esc(s.color)}">
    <div class="flex-1 min-w-[12rem]">
      <p class="font-medium ${s.status === 'done' ? 'line-through' : ''}"><button type="button" class="subj-link" data-subj="${esc(s.subject)}" title="Ouvrir les cours de cette matière">${esc(s.subject)}</button>${part} ${badges(s)}</p>
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
  $$('[data-subj]', root).forEach(b => b.onclick = e => { e.stopPropagation(); openSubject(b.dataset.subj, view); });
}

/** Ouvre la page « Mes cours » d'une matière (même présentation que dans Matières) ; le bouton Retour revient d'où on vient. */
const BACK_LABEL = { subjects: 'Matières', calendar: 'Calendrier', agenda: 'Agenda de révision', dashboard: 'Tableau de bord' };
let subjectBack = 'subjects';
function openSubject(name, from = 'subjects') {
  subjectBack = BACK_LABEL[from] ? from : 'subjects';
  show('subject', name);
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
  renderDueCard($('#review-card-dash')).catch(() => {});
  const [t, w, subs] = await Promise.all([api('/api/today'), api(`/api/week?start=${iso(monday(new Date()))}`), api('/api/subjects')]);
  $('#today-date').textContent = fmtLong(t.date);
  index(t.todo); index(t.upcoming);
  $('#todo-list').innerHTML = t.todo.length ? t.todo.map(s => sessionRow(s)).join('')
    : '<li class="text-sm text-slate-500 p-3">🎉 Rien à réviser aujourd\'hui. Importez votre emploi du temps si c\'est inattendu.</li>';
  $('#today-gauge').innerHTML = gauge(t.load);
  const indebted = subs.filter(x => x.backlog > 0 && x.enabled);
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
  const rvSlots = await reminderSlots(w);
  const docCounts = await library.counts().catch(() => ({}));
  const hours = w.day_end - w.day_start;
  const axis = [...Array(hours)].map((_, i) => `<div class="hour-line text-[10px] text-slate-400 pr-1 text-right" style="height:${HOUR_PX}px">${pad(w.day_start + i)}h</div>`).join('');
  let head = '<div></div>', cols = `<div>${axis}</div>`;
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    const k = iso(d), today = k === iso(new Date());
    head += `<div class="p-2 border-l border-slate-200 ${today ? 'bg-slate-900 text-white' : ''}"><p class="text-sm font-medium capitalize">${fmtShort(k)}</p><div class="${today ? 'opacity-90' : ''}">${gauge(w.load[k]).split('<p')[0]}</div></div>`;
    const ev = [];
    rvSlots.filter(r => r.day === k).forEach(r => {
      const top = (+r.start.slice(0, 2) * 60 + +r.start.slice(3) - w.day_start * 60) / 60 * HOUR_PX;
      ev.push(`<div class="ev remind" role="button" tabindex="0" data-rv-slot="${r.id}" style="top:${top}px;height:16px;color:${esc(r.color)}"
        title="Rappel facultatif (${r.start}–${r.end}) : ${esc(r.name)}. Clique pour réviser."><b>🔁 ${esc(r.name)}</b>
        <button type="button" class="mini" data-rv-skip="${r.id}" title="Reporter à demain" aria-label="Reporter à demain">✗</button></div>`);
    });
    w.courses.filter(c => c.start.slice(0, 10) === k).forEach(c => {
      const top = (mins(c.start) - w.day_start * 60) / 60 * HOUR_PX, h = Math.max(18, (mins(c.end) - mins(c.start)) / 60 * HOUR_PX);
      const nDocs = docCounts[fold(c.subject)] || 0;
      ev.push(`<div class="ev course" role="button" tabindex="0" data-subj="${esc(c.subject)}" style="top:${top}px;height:${h}px;background:${esc(c.color)}22;border-left:4px solid ${esc(c.color)}"
        title="${esc(c.summary)} — clique pour ouvrir / ajouter les cours de cette matière">
        <b>${esc(c.subject)}</b> ${esc(c.kind)}${nDocs ? ` <span class="doc-count">📎 ${nDocs}</span>` : ''}<br>${hhmm(c.start)}–${hhmm(c.end)}${c.room ? ' · ' + esc(c.room) : ''}</div>`);
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
        <b data-subj="${esc(s.subject)}" class="subj-link" title="Ouvrir les cours de cette matière">${s.catchup ? '↻' : '✎'} ${esc(s.subject)}</b>${s.overloaded ? ' ⚠️' : ''}<br>${hhmm(s.start)}–${hhmm(s.end)} ${acts}</div>`);
    });
    cols += `<div class="week-grid border-l border-slate-200" data-day="${k}" style="height:${hours * HOUR_PX}px;background-image:repeating-linear-gradient(to bottom,#e2e8f0 0,#e2e8f0 1px,transparent 1px,transparent ${HOUR_PX}px)">${ev.join('')}</div>`;
  }
  $('#calendar').innerHTML = `<div class="grid" style="grid-template-columns:44px repeat(7,1fr)">${head}</div>
    <div class="grid" style="grid-template-columns:44px repeat(7,1fr)">${cols}</div>`;
  bindSessionActions($('#calendar'));
  bindDrag(w.day_start);
  $$('#calendar .course').forEach(el => el.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSubject(el.dataset.subj, 'calendar'); }
  });
  $$('#calendar [data-rv-slot]').forEach(el => {
    const open = () => { reviewIntent = el.dataset.rvSlot; show('doc', el.dataset.rvSlot); };
    el.onclick = open; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  $$('#calendar [data-rv-skip]').forEach(b => b.onclick = guard(async e => {
    e.stopPropagation();
    await updateSrs(b.dataset.rvSkip, c => SRS.snooze(c, todayIso(), 1)); toast('Reporté à demain'); await refresh();
  }));
}

/** Rappels facultatifs de la semaine affichée, posés dans les trous libres (rien n'est enregistré : recalculé à chaque affichage). */
async function reminderSlots(w) {
  try {
    const docs = await library.withSrs(await activeKeep());
    if (!docs.length) return [];
    const colors = Object.fromEntries((await api('/api/subjects')).map(s => [fold(s.name), s.color]));
    const now = new Date();
    return SRS.placeReminders(docs, w, todayIso(), now.getHours() * 60 + now.getMinutes()).map(r => {
      const d = docs.find(x => x.id === r.id);
      return { ...r, name: d.name, color: colors[d.subject] || '#64748b' };
    });
  } catch { return []; }
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
  renderDueCard($('#review-card-agenda')).catch(() => {});
  const a = await api('/api/agenda');
  index(a.sessions);
  const byDay = {};
  a.sessions.forEach(s => (byDay[s.day] ||= []).push(s));
  if (!a.sessions.length) {
    $('#agenda-list').innerHTML = '<p class="text-slate-500">Aucune révision planifiée. Importez votre emploi du temps.</p>';
    return;
  }
  // jours avec révisions + les 14 prochains jours (même vides) pour pouvoir y déposer une matière
  const today = todayIso(), all = new Set(Object.keys(byDay));
  for (let i = 0; i < 14; i++) { const d = new Date(); d.setDate(d.getDate() + i); all.add(iso(d)); }
  const days = [...all].sort();
  $('#agenda-list').innerHTML = days.map(k => {
    const list = byDay[k] || [];
    const droppable = k >= today;
    return `<div class="agenda-day${droppable ? ' droppable' : ''}" data-day="${k}">
      <div class="flex items-center gap-3 mb-2"><h3 class="font-medium capitalize ${k === today ? 'text-blue-600' : ''}">${fmtLong(k)}</h3>
      <div class="w-40">${gauge(a.load[k])}</div></div>
      <ul class="space-y-2">${list.map(s => sessionRow(s, false, droppable && s.status === 'pending')).join('')}</ul>
      ${list.length ? '' : '<p class="agenda-empty">Rien de prévu · dépose une matière ici</p>'}</div>`;
  }).join('');
  bindSessionActions($('#agenda-list'));
  bindAgendaDrag();
}

/** Glisser-déposer : on attrape une matière et on la lâche sur le jour voulu (l'heure est conservée, ⇄ « Modifier » pour l'ajuster). */
function bindAgendaDrag() {
  const root = $('#agenda-list');
  $$('[data-drag-sid]', root).forEach(el => {
    el.ondragstart = e => {
      e.dataTransfer.setData('text/plain', el.dataset.dragSid);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging'); root.classList.add('is-dragging');
    };
    el.ondragend = () => {
      el.classList.remove('dragging'); root.classList.remove('is-dragging');
      $$('.agenda-day', root).forEach(d => d.classList.remove('drop-over'));
    };
  });
  $$('.agenda-day.droppable', root).forEach(day => {
    day.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; day.classList.add('drop-over'); };
    day.ondragleave = e => { if (!day.contains(e.relatedTarget)) day.classList.remove('drop-over'); };
    day.ondrop = guard(async e => {
      e.preventDefault(); day.classList.remove('drop-over'); root.classList.remove('is-dragging');
      const s = sessionIndex[e.dataTransfer.getData('text/plain')];
      if (!s || s.day === day.dataset.day) return;
      await api(`/api/sessions/${s.id}`, { method: 'PATCH', json: { day: day.dataset.day, start: hhmm(s.start) } });
      toast(`« ${s.subject} » déplacée au ${fmtShort(day.dataset.day)}`); await refresh();
    });
  });
}

/* ---------------------------------------------------------------- matières */
function subjectSummary(s) {
  const base = `→ ${s.slots} créneau${s.slots > 1 ? 'x' : ''} de ${fmtDur(s.slot_minutes)} (${fmtDur(s.total_minutes)} par cours)`;
  return s.backlog ? `${base} + ${s.backlog} rattrapage${s.backlog > 1 ? 's' : ''} (${fmtDur(s.debt_minutes)} de dette)` : base;
}
let subjFilter = '', subjSort = 'name';
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
async function setSubjectEnabled(name, enabled) {
  await api('/api/subjects', { method: 'PUT', json: { name, enabled } });
}
/** Filtre « cours des matières encore révisées » pour les rappels. */
async function activeKeep() {
  const act = new Set((await api('/api/subjects')).filter(s => s.enabled).map(s => fold(s.name)));
  return r => act.has(r.subject);
}

async function loadSubjects() {
  const [list, counts, srsDocs] = await Promise.all([api('/api/subjects'), library.counts(), library.withSrs()]);
  const today = todayIso(), dueBy = {};
  srsDocs.forEach(d => { if (d.srs.due <= today) dueBy[d.subject] = (dueBy[d.subject] || 0) + 1; });
  const active = list.filter(s => s.enabled), idle = list.filter(s => !s.enabled);
  const q = fold(subjFilter);
  const sorters = { name: (a, b) => fold(a.name).localeCompare(fold(b.name)), load: (a, b) => b.total_minutes - a.total_minutes || sorters.name(a, b),
                    backlog: (a, b) => b.backlog - a.backlog || b.total_minutes - a.total_minutes };
  const shown = active.filter(s => !q || fold(s.name).includes(q)).sort(sorters[subjSort] || sorters.name);

  const total = active.reduce((n, s) => n + s.total_minutes, 0);
  $('#subj-summary').textContent = list.length
    ? `${plural(active.length, 'matière à réviser', 'matières à réviser')}${active.length ? `, soit ${fmtDur(total)} de révisions au total` : ''}${idle.length ? ` · ${plural(idle.length, 'non révisée', 'non révisées')}` : ''}`
    : '';
  $('#subj-pick').classList.toggle('hidden', !list.length);

  const num = (name, label, v, min, max, step) => `<label class="text-xs text-slate-600">${label}
    <input type="number" data-f="${name}" value="${v}" min="${min}" max="${max}" step="${step}" class="w-full border rounded-lg px-2 py-1 text-sm mt-0.5"></label>`;
  $('#subjects-list').innerHTML = shown.map(s => {
    const n = counts[fold(s.name)] || 0, due = dueBy[fold(s.name)] || 0;
    return `<article class="subj-card" data-name="${esc(s.name)}" style="--c:${esc(s.color)}">
      <div class="flex items-start gap-3">
        <input type="color" data-f="color" value="${esc(s.color)}" class="subj-color" aria-label="Couleur de ${esc(s.name)}" title="Changer la couleur">
        <div class="min-w-0 flex-1">
          <h3><button type="button" data-open="${esc(s.name)}" class="subj-name" title="Ouvrir les cours de cette matière">${esc(s.name)}</button></h3>
          <p class="subj-sum summary">${subjectSummary(s)}</p>
        </div>
      </div>
      <div class="subj-chips">
        <span class="subj-chip">📂 ${n ? plural(n, 'cours', 'cours') : 'aucun cours ajouté'}</span>
        ${due ? `<span class="subj-chip warn">🔁 ${plural(due, 'rappel', 'rappels')}</span>` : ''}
        ${s.backlog ? `<span class="subj-chip late">${plural(s.backlog, 'rattrapage', 'rattrapages')}</span>` : ''}
      </div>
      <div class="subj-actions">
        <button type="button" data-open="${esc(s.name)}" class="subj-btn primary">Mes cours</button>
        <button type="button" data-idle="${esc(s.name)}" class="subj-btn quiet" title="Plus de créneaux ni de rappels pour cette matière">Ne plus réviser</button>
      </div>
      <details class="subj-settings"><summary>Réglages du planning</summary>
        <div class="grid grid-cols-2 gap-3">
          ${num('session_minutes', 'Durée d\'une session (min)', s.session_minutes, 5, 480, 5)}
          ${num('intensity', 'Intensité (×)', s.intensity, 0.25, 5, 0.25)}
          ${num('chapters', 'Chapitres à revoir', s.chapters, 1, 60, 1)}
          ${num('chapters_per_session', 'Chapitres / session', s.chapters_per_session, 1, 30, 1)}
          ${num('backlog', 'Cours en retard (dette)', s.backlog, 0, 99, 1)}
        </div></details></article>`;
  }).join('');
  const none = $('#subjects-none');
  none.classList.toggle('hidden', !!shown.length);
  none.textContent = !list.length ? 'Aucune matière : importe d\'abord ton emploi du temps.'
    : !active.length ? 'Aucune matière à réviser pour le moment. Remets-en depuis la section « Non révisées » ci-dessous.'
    : 'Aucune matière ne correspond à ta recherche.';

  const box = $('#subjects-idle-box');
  box.classList.toggle('hidden', !idle.length);
  $('#idle-title').textContent = `Non révisées (${idle.length})`;
  $('#subjects-idle').innerHTML = idle.map(s => `<li class="idle-row"><span class="dot" style="background:${esc(s.color)}"></span>
    <button type="button" data-open="${esc(s.name)}" class="font-medium hover:underline truncate text-left" title="Ouvrir les cours de cette matière">${esc(s.name)}</button>
    <span class="text-xs text-slate-500">${counts[fold(s.name)] ? plural(counts[fold(s.name)], 'cours', 'cours') : ''}</span>
    <button type="button" data-back="${esc(s.name)}" class="subj-btn ml-auto">Remettre dans mes révisions</button></li>`).join('');

  $$('#view-subjects [data-open]').forEach(b => b.onclick = () => openSubject(b.dataset.open, 'subjects'));
  $$('#subjects-list [data-idle]').forEach(b => b.onclick = guard(async () => {
    await setSubjectEnabled(b.dataset.idle, false); toast(`« ${b.dataset.idle} » retirée de tes révisions`); await loadSubjects();
  }));
  $$('#subjects-idle [data-back]').forEach(b => b.onclick = guard(async () => {
    await setSubjectEnabled(b.dataset.back, true); toast('Matière remise dans tes révisions'); await loadSubjects();
  }));
  $$('#subjects-list [data-f]').forEach(inp => {
    inp.onchange = guard(async () => {
      const card = inp.closest('[data-name]');
      await api('/api/subjects', { method: 'PUT', json: { name: card.dataset.name, [inp.dataset.f]: inp.value } });
      const fresh = (await api('/api/subjects')).find(x => x.name === card.dataset.name);
      $('.summary', card).textContent = subjectSummary(fresh);
      if (inp.dataset.f === 'color') card.style.setProperty('--c', inp.value);
      toast('Agenda recalculé');
    });
  });
}
$('#subj-search').oninput = e => { subjFilter = e.target.value; loadSubjects(); };
$('#subj-sort').onchange = e => { subjSort = e.target.value; loadSubjects(); };

/* ---- choisir en une fois les matières à réviser */
$('#subj-pick').onclick = guard(async () => {
  const list = await api('/api/subjects');
  $('#subj-checks').innerHTML = list.map(s => `<li><label class="flex items-center gap-2 p-1.5 rounded-lg hover:bg-slate-50 cursor-pointer">
    <input type="checkbox" value="${esc(s.name)}" ${s.enabled ? 'checked' : ''} data-was="${s.enabled ? 1 : 0}">
    <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${esc(s.color)}"></span><span class="truncate">${esc(s.name)}</span></label></li>`).join('');
  $('#subj-dialog').showModal();
});
$('#subj-all').onclick = () => $$('#subj-checks input').forEach(i => { i.checked = true; });
$('#subj-none').onclick = () => $$('#subj-checks input').forEach(i => { i.checked = false; });
$('#subj-cancel').onclick = () => $('#subj-dialog').close();
$('#subj-form').onsubmit = guard(async () => {
  const changed = $$('#subj-checks input').filter(i => i.checked !== (i.dataset.was === '1'));
  for (const i of changed) await setSubjectEnabled(i.value, i.checked);
  if (changed.length) toast(`${plural(changed.length, 'matière modifiée', 'matières modifiées')} : agenda recalculé`);
  await loadSubjects();
});

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
const KIND_ICON = { pdf: '📕', docx: '📘', pptx: '📙', text: '📝' };
const fmtSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`;
let currentSubject = null;

async function loadSubject(name) {
  const subs = await api('/api/subjects');
  const s = subs.find(x => fold(x.name) === fold(name));
  if (!s) return show('subjects');
  currentSubject = s;
  $('#subj-back').textContent = `← ${BACK_LABEL[subjectBack]}`;
  $('#subj-dot').style.background = s.color;
  $('#subj-title').textContent = s.name;
  $('#lib-warning').classList.toggle('hidden', library.persistent);
  const docs = await library.list(s.name);
  $('#docs-list').innerHTML = docs.length ? docs.map(d => `<li class="flex items-center gap-3 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-400" style="border-left:5px solid ${esc(s.color)}">
      <button data-doc="${d.id}" class="flex-1 min-w-0 text-left">
        <p class="font-medium truncate">${KIND_ICON[d.kind] || '📄'} ${esc(d.name)} ${d.has_summary ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 align-middle">✨ résumé</span>' : ''}
          ${d.srs ? `<span class="text-[10px] px-1.5 py-0.5 rounded align-middle ${d.srs.due <= iso(new Date()) ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}">🔁 ${esc(SRS.dueLabel(d.srs.due, iso(new Date())))}</span>` : ''}</p>
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

/** Une diapositive PowerPoint : titre, puces indentées, notes du présentateur. */
function slideCard(n, body) {
  const lines = body.split('\n').filter(l => l.trim());
  let title = '', notes = '';
  if (lines.length && !/^\s*- /.test(lines[0]) && !lines[0].startsWith('Notes : ')) title = lines.shift();
  if (lines.length && lines[lines.length - 1].startsWith('Notes : ')) notes = lines.pop().slice(8);
  const items = lines.map(l => { const m = l.match(/^( *)- (.*)$/); return m ? { l: m[1].length / 2, t: m[2] } : { l: 0, t: l.trim() }; });
  return `<section class="slide"><div class="slide-n">Diapo ${esc(n)}</div>${title ? `<h3>${esc(title)}</h3>` : ''}
    ${items.length ? `<ul>${items.map(i => `<li style="margin-left:${i.l * 1.25}rem">${esc(i.t)}</li>`).join('')}</ul>` : ''}
    ${notes ? `<p class="slide-notes"><b>Notes du présentateur.</b> ${esc(notes)}</p>` : ''}</section>`;
}
function renderReader(text) {
  const parts = text.split(/\n*\[(Page|Diapo) (\d+)\]\n/);          // [avant, type, n°, texte, type, n°, texte…]
  const para = t => t.split(/\n{2,}/).filter(x => x.trim()).map(x => `<p>${esc(x.trim())}</p>`).join('');
  let html = parts[0].trim() ? para(parts[0]) : '';
  for (let i = 1; i < parts.length; i += 3) {
    html += parts[i] === 'Diapo' ? slideCard(parts[i + 1], parts[i + 2] || '')
      : `<div class="page-mark">Page ${esc(parts[i + 1])}</div>${para(parts[i + 2] || '')}`;
  }
  $('#doc-text').innerHTML = html;
}

/* PDF : affichage visuel des pages (idéal pour des diapositives exportées) ou texte extrait */
let pdfHandle = null, pdfMount = null;
function leavePdf() {
  if (pdfMount) pdfMount.destroy(); else if (pdfHandle) { try { pdfHandle.pdf.destroy(); } catch { /* déjà fermé */ } }
  pdfHandle = null; pdfMount = null;
  $('#doc-mode').classList.add('hidden'); $('#doc-pages').classList.add('hidden'); $('#doc-pages').textContent = '';
  $('#doc-text').classList.remove('hidden'); $('#doc-article').classList.remove('reader-wide');
}
function setMode(mode) {
  const pages = mode === 'pages' && !!pdfHandle;
  $$('#doc-mode [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === (pages ? 'pages' : 'text'))));
  $('#doc-text').classList.toggle('hidden', pages);
  $('#doc-pages').classList.toggle('hidden', !pages);
  $('#doc-article').classList.toggle('reader-wide', pages);
  if (pages && !pdfMount) pdfMount = mountPages(pdfHandle, $('#doc-pages'), pdfHandle.landscape ? 'Diapo' : 'Page');
}
$$('#doc-mode [data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
async function setupPdf(d, token) {
  if (d.kind !== 'pdf' || !d.blob) return;
  try {
    const h = await openPdf(d.blob);
    if (token !== docToken) { try { h.pdf.destroy(); } catch { /* ignoré */ } return; }
    pdfHandle = h;
    $('#doc-mode').classList.remove('hidden');
    setMode(h.landscape ? 'pages' : 'text');       // un PDF en paysage = très probablement des diapositives
  } catch { /* PDF non affichable : on garde le texte */ }
}

const scrollChat = () => { const b = $('#ai-scroll'); b.scrollTop = b.scrollHeight; };
function renderChat() {
  const n = doc.chat.length;
  $('#ai-chat').innerHTML = doc.chat.map((m, i) => m.role === 'user'
    ? `<div class="msg msg-user">${esc(m.content)}</div>`
    : `<div class="msg msg-ai"><div class="ai-md">${mdToHtml(m.content)}</div><button type="button" class="copy-btn" data-copy="${i}">Copier</button></div>`).join('');
  $('#ai-empty').classList.toggle('hidden', n > 0);
  $('#ai-suggest').innerHTML = AI.QUICK_ACTIONS.map((a, i) => `<li><button type="button" data-qa="${i}"><span aria-hidden="true">${a.icon}</span>${esc(a.label)}</button></li>`).join('');
  $('#ai-quick').innerHTML = n ? AI.QUICK_ACTIONS.map((a, i) => `<button type="button" data-qa="${i}">${a.icon} ${esc(a.label)}</button>`).join('') : '';
  $$('#ai-suggest [data-qa], #ai-quick [data-qa]').forEach(b => b.onclick = () => sendQuestion(AI.QUICK_ACTIONS[b.dataset.qa].prompt));
}
$('#ai-chat').addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]');
  if (!b || !doc) return;
  try { await navigator.clipboard.writeText(doc.chat[b.dataset.copy].content); toast('Réponse copiée'); }
  catch { toast('Copie impossible dans ce navigateur', false); }
});
$('#ai-reset-chat').onclick = guard(async () => {
  if (!doc || !doc.chat.length || !confirm('Effacer la conversation de ce cours ?')) return;
  doc.chat = []; await library.update(doc.id, { chat: [] }); renderChat();
});
const typing = on => {
  $('#ai-chat').querySelector('.typing-row')?.remove();
  if (on) $('#ai-chat').insertAdjacentHTML('beforeend', '<div class="msg msg-ai typing-row" aria-label="L\'assistant écrit"><span class="typing"><span></span><span></span><span></span></span></div>');
  scrollChat();
};
const errBubble = msg => { $('#ai-chat').insertAdjacentHTML('beforeend', `<div class="msg msg-err" role="alert">${esc(msg)}</div>`); scrollChat(); };
const aiConfig = () => AI.activeConfig(aiSettings);
function updateAiStatus(busyText = '') {
  const el = $('#ai-status'), c = aiConfig();
  el.className = 'ai-status' + (busyText ? ' busy' : c.key ? ' ready' : '');
  el.textContent = busyText || (c.key ? c.model : 'Clé API à ajouter');
}
const aiContext = () => AI.systemPrompt({ subject: doc.subject_name, title: doc.name, text: doc.text });

function renderSummary(state, msg = '') {
  const el = $('#ai-summary'), btn = $('#ai-resum');
  btn.classList.toggle('hidden', !(doc && doc.summary) || aiBusy);
  if (state !== 'ready') el.closest('details').open = true;
  if (state === 'ready') el.innerHTML = mdToHtml(doc.summary);
  else if (state === 'loading') el.innerHTML = '<span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="sr-only">Lecture du cours en cours</span>';
  else if (state === 'nokey') el.innerHTML = `<p class="text-slate-600">Ajoute ta clé API pour obtenir un résumé du cours et lui poser tes questions.</p>
      <button type="button" data-config class="tool tool-primary mt-3">Ajouter ma clé</button>`;
  else el.innerHTML = `<p class="text-red-700" role="alert">${esc(msg)}</p><button type="button" data-retry class="tool mt-3">Réessayer</button>`;
  $('[data-config]', el)?.addEventListener('click', openAiSettings);
  $('[data-retry]', el)?.addEventListener('click', () => summarize());
}

async function summarize() {
  const cfg = aiConfig(), token = docToken;
  if (!cfg.key) return renderSummary('nokey');
  aiBusy = true; renderSummary('loading'); updateAiStatus('Lit le cours…');
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
  } finally { if (token === docToken) { aiBusy = false; updateAiStatus(); } }
}
$('#ai-resum').onclick = () => { if (!aiBusy) summarize(); };

async function sendQuestion(text) {
  text = String(text || '').trim();
  if (!text || aiBusy || !doc) return;
  const cfg = aiConfig(), token = docToken;
  if (!cfg.key) return openAiSettings();
  aiBusy = true; $('#ai-send').disabled = true; updateAiStatus('Réfléchit…');
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
    if (token === docToken) { aiBusy = false; $('#ai-send').disabled = false; typing(false); updateAiStatus(); renderSummary(doc.summary ? 'ready' : 'nokey'); scrollChat(); }
  }
}
const autosize = () => { const t = $('#ai-input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; };
$('#ai-input').oninput = autosize;
$('#ai-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendQuestion(e.target.value); } };
$('#ai-form').onsubmit = e => { e.preventDefault(); sendQuestion($('#ai-input').value); };

const KIND_LABEL = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', text: 'Texte' };
const inkOn = hex => {                                    // texte lisible (blanc ou noir) sur la couleur de la matière
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff';
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).map(c => (c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4));
  return .2126 * r + .7152 * g + .0722 * b > .35 ? '#1c2430' : '#fff';
};
function renderMeta(d) {
  const marks = d.text.match(/^\[(Page|Diapo) \d+\]$/gm) || [];
  const unit = d.kind === 'pptx' || (marks[0] || '').startsWith('[Diapo') ? 'diapo' : 'page';
  const words = (d.text.match(/\S+/g) || []).length;
  const parts = [`<span>${KIND_LABEL[d.kind] || 'Document'}</span>`];
  if (marks.length) parts.push(`<span><b>${marks.length}</b> ${unit}${marks.length > 1 ? 's' : ''}</span>`);
  parts.push(`<span><b>${Math.max(1, Math.round(words / 200))} min</b> de lecture</span>`, `<span>${fmtSize(d.size)}</span>`);
  $('#doc-meta').innerHTML = parts.join('');
}

/* ---- taille du texte, progression de lecture, plein écran */
const SIZE_KEY = 'campass-revisions-reader-size';
let readerSize = 1.08;
try { const v = Number(localStorage.getItem(SIZE_KEY)); if (v >= .9 && v <= 1.6) readerSize = v; } catch { /* stockage indisponible */ }
const applySize = () => $('#doc-text').style.setProperty('--reader-size', readerSize + 'rem');
$$('#doc-size [data-size]').forEach(b => b.onclick = () => {
  readerSize = Math.min(1.6, Math.max(.9, Math.round((readerSize + Number(b.dataset.size) * .08) * 100) / 100));
  applySize(); try { localStorage.setItem(SIZE_KEY, String(readerSize)); } catch { /* ignoré */ }
});

function updateProgress() {
  if (view !== 'doc') return;
  const a = $('#doc-article'); let ratio;
  if ($('#view-doc').classList.contains('doc-full')) ratio = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
  else { const r = a.getBoundingClientRect(); ratio = -r.top / Math.max(1, r.height - innerHeight * .7); }
  ratio = Math.min(1, Math.max(0, ratio));
  $('#doc-progress i').style.width = (ratio * 100).toFixed(1) + '%';
  $('#doc-progress').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
}
addEventListener('scroll', updateProgress, { passive: true });
$('#doc-article').addEventListener('scroll', updateProgress, { passive: true });
addEventListener('resize', updateProgress);

const full = { on: false };
function setFull(on) {
  const v = $('#view-doc');
  full.on = on;
  v.classList.toggle('doc-full', on);
  document.body.classList.toggle('no-scroll', on);
  $('#doc-full').setAttribute('aria-pressed', String(on));
  $('#doc-full-label').textContent = on ? 'Quitter' : 'Plein écran';
  $('#doc-ai-toggle').classList.toggle('hidden', !on);
  if (on) {
    v.classList.toggle('ai-hidden', innerWidth < 1024);               // sur petit écran, l'assistant s'ouvre à la demande
    $('#doc-ai-toggle').setAttribute('aria-pressed', String(!v.classList.contains('ai-hidden')));
    // vrai plein écran du navigateur quand il existe (pas sur iPhone) ; sinon le mode « plein cadre » CSS suffit
    try { (v.requestFullscreen || v.webkitRequestFullscreen)?.call(v)?.catch?.(() => {}); } catch { /* ignoré */ }
  } else {
    v.classList.remove('ai-hidden');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  requestAnimationFrame(updateProgress);
}
$('#doc-full').onclick = () => setFull(!full.on);
$('#doc-ai-toggle').onclick = () => {
  const v = $('#view-doc'); v.classList.toggle('ai-hidden');
  $('#doc-ai-toggle').setAttribute('aria-pressed', String(!v.classList.contains('ai-hidden')));
};
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && full.on) setFull(false); });
document.addEventListener('keydown', e => {
  if (view !== 'doc' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && full.on && !document.fullscreenElement) setFull(false);
  else if ((e.key === 'f' || e.key === 'F') && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !$('#ai-dialog').open) { e.preventDefault(); setFull(!full.on); }
});

let docSubjectActive = true;
async function loadDoc(id) {
  const d = await library.get(id);
  if (!d) { toast('Cours introuvable', false); return show('subjects'); }
  docToken++; leavePdf(); doc = d; aiBusy = false; $('#ai-send').disabled = false;
  aiSettings = AI.loadSettings();
  const subs = await api('/api/subjects').catch(() => []);
  const sub = subs.find(x => fold(x.name) === fold(d.subject_name));
  const color = sub?.color || '#4f46e5';
  docSubjectActive = sub ? !!sub.enabled : true;
  const root = $('#view-doc');
  root.style.setProperty('--accent', color); root.style.setProperty('--accent-ink', inkOn(color));
  $('#doc-title').textContent = d.name;
  renderMeta(d);
  $('#doc-back-label').textContent = d.subject_name;
  $('#doc-original').classList.toggle('hidden', !d.blob);
  updateAiStatus(); applySize();
  renderReader(d.text); renderChat();
  window.scrollTo({ top: 0 }); $('#doc-article').scrollTop = 0; updateProgress();
  setupPdf(d, docToken);
  renderSrs();
  if (reviewIntent === String(d.id) && d.srs) showReviewBar(); else hideReviewBar();
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
    updateAiStatus();
    if (!doc.summary && !aiBusy) summarize();
  }
};

/* ---------------------------------------------------------------- rappels de mémorisation (répétition espacée) */
let reviewIntent = null;                                   // id du cours que l'utilisateur vient de choisir de réviser
const todayIso = () => iso(new Date());

async function updateSrs(id, fn) {                         // lit, transforme, enregistre la carte d'un cours
  const r = await library.get(id);
  if (!r) return null;
  const srs = fn(r.srs || null);
  await library.update(id, { srs });
  return srs;
}

/** Carte « À revoir » du tableau de bord et de l'agenda : facultatif, jamais bloquant. */
async function renderDueCard(el) {
  const today = todayIso(), r = await library.reviews(today, await activeKeep());
  if (!r.total) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const colors = Object.fromEntries((await api('/api/subjects')).map(s => [fold(s.name), s.color]));
  let html;
  if (!r.due.length) {
    html = `<div class="rv-quiet">🔁 Rien à revoir aujourd'hui. Prochain rappel ${esc(SRS.dueLabel(r.next.srs.due, today))} :
      <button type="button" class="underline" data-rv-open="${r.next.id}">${esc(r.next.name)}</button></div>`;
  } else {
    const shown = r.due.slice(0, 5);
    html = `<div class="bg-white rounded-xl border border-slate-200 p-5">
      <div class="flex items-baseline gap-2 mb-1"><h2 class="font-semibold">À revoir</h2><span class="text-xs text-slate-500">${r.due.length} cours</span></div>
      <p class="text-sm text-slate-500 mb-3">Pour que ça reste en mémoire. C'est facultatif : tu peux ignorer ou reporter sans conséquence.</p>
      <ul class="space-y-2">${shown.map(d => `<li class="rv-item" style="border-left-color:${esc(colors[d.subject] || '#94a3b8')}">
        <div class="min-w-0 flex-1"><button type="button" class="font-medium truncate text-left hover:underline max-w-full" data-rv-open="${d.id}">${esc(d.name)}</button>
          <p class="text-xs text-slate-500">${esc(d.subject_name)}, ${esc(SRS.dueLabel(d.srs.due, today))}</p></div>
        <button type="button" class="rv-btn rv-btn-primary" data-rv-go="${d.id}">Réviser</button>
        <button type="button" class="rv-btn" data-rv-later="${d.id}" title="Reporter à demain">Demain</button></li>`).join('')}</ul>
      ${r.due.length > shown.length ? `<p class="text-xs text-slate-500 mt-2">et ${r.due.length - shown.length} autre${r.due.length - shown.length > 1 ? 's' : ''}</p>` : ''}</div>`;
  }
  el.innerHTML = html; el.classList.remove('hidden');
  $$('[data-rv-open]', el).forEach(b => b.onclick = () => show('doc', b.dataset.rvOpen));
  $$('[data-rv-go]', el).forEach(b => b.onclick = () => { reviewIntent = b.dataset.rvGo; show('doc', b.dataset.rvGo); });
  $$('[data-rv-later]', el).forEach(b => b.onclick = guard(async () => {
    await updateSrs(b.dataset.rvLater, c => SRS.snooze(c, todayIso(), 1)); toast('Reporté à demain'); await renderDueCard(el);
  }));
}

/** Ligne d'état sous le titre du cours : démarrer les rappels, ou voir/ lancer le prochain. */
function renderSrs() {
  const row = $('#srs-row'), c = doc.srs, today = todayIso();
  if (!c) {
    row.innerHTML = `<button type="button" id="srs-start" class="tool">✓ J'ai travaillé ce cours</button>
      <label class="srs-hint">le <input type="date" id="srs-date" value="${today}" max="${today}" class="srs-date"></label>
      <span class="srs-hint">Lance des rappels de mémorisation, facultatifs.</span>`;
    $('#srs-start').onclick = guard(async () => {
      const day = /^\d{4}-\d{2}-\d{2}$/.test($('#srs-date').value) && $('#srs-date').value <= todayIso() ? $('#srs-date').value : todayIso();
      doc.srs = await updateSrs(doc.id, () => SRS.startCard(day));
      toast(SRS.isDue(doc.srs, todayIso()) ? 'Rappels lancés : le premier est à faire dès maintenant' : `Rappels lancés : le premier est ${SRS.dueLabel(doc.srs.due, todayIso())}`); renderSrs();
    });
    return;
  }
  const due = SRS.isDue(c, today);
  row.innerHTML = `<span class="srs-pill ${due ? 'due' : ''}">🔁 Rappel ${esc(SRS.dueLabel(c.due, today))}</span>
    <button type="button" id="srs-review" class="tool ${due ? 'tool-primary' : ''}">Réviser maintenant</button>
    <button type="button" id="srs-stop" class="link-btn">Arrêter les rappels</button>
    ${docSubjectActive ? '' : '<span class="srs-hint">Cette matière n\'est plus dans tes révisions : ses rappels sont masqués.</span>'}`;
  $('#srs-review').onclick = () => { reviewIntent = String(doc.id); showReviewBar(); };
  $('#srs-stop').onclick = guard(async () => {
    if (!confirm('Arrêter les rappels de ce cours ? Son historique de révision sera effacé.')) return;
    await updateSrs(doc.id, () => null); doc.srs = null; hideReviewBar(); renderSrs();
  });
}

const gradeButtons = (card, suggested = '') => {
  const iv = SRS.previewIntervals(card, todayIso());
  return SRS.GRADES.map(g => `<button type="button" class="grade grade-${g.id}${g.id === suggested ? ' suggested' : ''}" data-grade="${g.id}" title="${esc(g.hint)}">
    <b>${esc(g.label)}</b><small>${esc(SRS.intervalLabel(iv[g.id]))}</small></button>`).join('');
};
async function applyGrade(grade) {
  if (!doc || !doc.srs) return;
  doc.srs = await updateSrs(doc.id, c => SRS.review(c, grade, todayIso()));
  toast(`Prochain rappel ${SRS.dueLabel(doc.srs.due, todayIso())}`);
  reviewIntent = null; hideReviewBar(); renderSrs();
  if ($('#quiz-dialog').open) $('#quiz-dialog').close();
}
function showReviewBar() {
  $('#review-bar').classList.remove('hidden'); $('#review-choice').classList.remove('hidden'); $('#review-grade').classList.add('hidden');
  $('#review-quiz').disabled = !aiConfig().key; $('#review-quiz').title = aiConfig().key ? '' : 'Ajoute d\'abord ta clé API dans les réglages de l\'assistant';
}
function hideReviewBar() { $('#review-bar').classList.add('hidden'); }
function startReread() {
  $('#review-choice').classList.add('hidden'); $('#review-grade').classList.remove('hidden');
  $('#review-grade-btns').innerHTML = gradeButtons(doc.srs);
  if ($('#quiz-dialog').open) $('#quiz-dialog').close();
  $('#review-bar').scrollIntoView({ block: 'nearest' });
}
$('#review-reread').onclick = startReread;
$('#review-cancel').onclick = () => { reviewIntent = null; hideReviewBar(); };
$('#review-quiz').onclick = () => startQuiz();
$('#review-grade-btns').onclick = guard(async e => { const b = e.target.closest('[data-grade]'); if (b) await applyGrade(b.dataset.grade); });

/* ---- test de mémoire : questions de l'IA, réponse de tête, auto-évaluation */
let quiz = null, quizSession = 0;
async function startQuiz() {
  if (!doc || !doc.srs) return;
  if (!aiConfig().key) return openAiSettings();
  const session = ++quizSession;
  quiz = null; $('#quiz-title').textContent = doc.name;
  if (!$('#quiz-dialog').open) $('#quiz-dialog').showModal();
  quizRender('loading');
  try {
    const text = await AI.ask(aiConfig(), { system: aiContext(), messages: [{ role: 'user', content: AI.quizRequest(Date.now() % 1000) }] });
    if (session !== quizSession) return;
    const cards = AI.parseQuiz(text);
    if (!cards) throw new Error('L\'assistant n\'a pas renvoyé de questions exploitables. Réessaie.');
    quiz = { cards, i: 0, right: 0, revealed: false };
    quizRender('card');
  } catch (e) { if (session === quizSession) quizRender('error', e.message); }
}
function quizRender(state, msg = '') {
  const el = $('#quiz-body'), q = quiz;
  $('#quiz-count').textContent = state === 'card' ? `Question ${q.i + 1} sur ${q.cards.length}` : '';
  if (state === 'loading') {
    el.innerHTML = '<span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><p class="quiz-note">L\'assistant prépare tes questions…</p>';
  } else if (state === 'error') {
    el.innerHTML = `<p class="text-red-700" role="alert">${esc(msg)}</p><div class="quiz-actions"><button type="button" id="quiz-retry" class="tool tool-primary">Réessayer</button><button type="button" id="quiz-reread" class="tool">Relire le cours à la place</button></div>`;
    $('#quiz-retry').onclick = () => startQuiz(); $('#quiz-reread').onclick = startReread;
  } else if (state === 'card') {
    const c = q.cards[q.i];
    el.innerHTML = `<div class="quiz-progress"><i style="width:${(q.i / q.cards.length) * 100}%"></i></div><p class="quiz-q">${esc(c.q)}</p>` + (q.revealed
      ? `<div class="quiz-a ai-md">${mdToHtml(c.a)}</div><p class="quiz-note">Tu le savais ?</p>
         <div class="quiz-actions"><button type="button" class="tool" data-know="0">Pas vraiment</button><button type="button" class="tool tool-primary" data-know="1">Je savais</button></div>`
      : `<p class="quiz-note">Réponds de tête, ou à voix haute, puis vérifie.</p><div class="quiz-actions"><button type="button" id="quiz-reveal" class="tool tool-primary">Voir la réponse</button></div>`);
    $('#quiz-reveal')?.addEventListener('click', () => { q.revealed = true; quizRender('card'); });
    $$('[data-know]', el).forEach(b => b.onclick = () => {
      q.right += Number(b.dataset.know); q.i++; q.revealed = false;
      quizRender(q.i < q.cards.length ? 'card' : 'end');
    });
  } else {
    const n = q.cards.length, suggested = SRS.suggestGrade(q.right / n);
    el.innerHTML = `<p class="quiz-score">${q.right} / ${n}</p><p>Choisis la note qui correspond à ce que tu ressens : elle fixe la date du prochain rappel (suggestion en surbrillance).</p>
      <div class="grade-row">${gradeButtons(doc.srs, suggested)}</div>`;
    $$('[data-grade]', el).forEach(b => b.onclick = guard(async () => applyGrade(b.dataset.grade)));
  }
}
$('#quiz-close').onclick = () => $('#quiz-dialog').close();
$('#quiz-dialog').addEventListener('close', () => { quizSession++; });

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
  if (full.on && v !== 'doc') setFull(false);
  view = loaders[v] ? v : 'dashboard';
  param = (view === 'subject' || view === 'doc') && p != null && p !== '' ? String(p) : null;
  if ((view === 'subject' || view === 'doc') && param === null) view = 'subjects';
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== `view-${view}`));
  const navView = view === 'subject' ? subjectBack : (NAV_OF[view] || view);
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === navView));
  $('main').classList.toggle('max-w-6xl', view !== 'doc');          // le lecteur utilise toute la largeur
  history.replaceState(null, '', `#${view}${param !== null ? '/' + encodeURIComponent(param) : ''}`);
  refresh();
}
$$('[data-view]').forEach(b => b.onclick = () => show(b.dataset.view));
$('#subj-back').onclick = () => show(subjectBack);
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
await backend.autoSync();            // rafraîchit en silence si un lien est enregistré et ancien
{
  const [v, ...rest] = location.hash.slice(1).split('/');
  let p = null; try { p = decodeURIComponent(rest.join('/')); } catch { /* hash invalide */ }
  show(v || 'dashboard', p);
}
