/* Interface Révisions Campass — JS vanilla. Données et calculs dans le navigateur (voir backend.js). */
import { createBackend } from './backend.js';
import { Store } from './store.js';
import { openLibrary, fold } from './library.js';
import { extractText, kindOf, ACCEPT } from './extract.js';
import { openPdf, mountPages } from './pdfview.js';
import * as AI from './ai.js';
import * as SRS from './srs.js';
import { startCard } from './srs.js';
import { mdToHtml } from './md.js';
import { busyIntervals, freeSlot, spreadSessions, prioritize } from './scheduling.js';
import { buildIcs } from './ics-export.js';
import { cleanLog, weekByDay, streak, doneRate, mondayOf, challenges, weekRecap, recapText } from './stats.js';
import { cleanCards, addCards, dueCards, gradeCard, cardsRequest, parseCards, recallRequest } from './cards.js';
import { LEVELS } from './confidence.js';
import { buildShare, parseShare, newCourses, encodeShare, decodeShare } from './share.js';
import { WORK, workType, examNoun, kindNoun, unitRange, guessTopic } from './kinds.js';

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

/** Ouvre le bon document d'un créneau : le dernier TD pour des exercices, le dernier cours sinon ; sinon la page de la matière. */
/** Le document d'une matière qui correspond au type de travail (dernier TD pour des exercices, dernier cours sinon). */
async function pickDoc(subject, work) {
  const want = work === 'practice' ? 'td' : 'cours', docs = await library.list(subject);
  return docs.find(x => (x.topic || 'cours') === want) || docs[0] || null;
}
async function openSessionDoc(s, from) {
  const want = s.work === 'practice' ? 'td' : 'cours', d = await pickDoc(s.subject, s.work);
  if (d) show('doc', d.id); else { toast(`Aucun ${want === 'td' ? 'TD' : 'cours'} déposé : ajoute-le ici`); openSubject(s.subject, from); }
}
const workPill = s => { const w = WORK[s.work] || WORK.review; return `<span class="work-pill ${esc(s.work || 'review')}" title="${esc(w.action)}">${w.icon} ${w.label}</span>`; };
/** « Apprendre le cours du lun. 2 · chap. 1–2 · avant le TD du mar. 10 » / « Refaire les exercices du lun. 2 · série 1 · avant le cours… » */
function sessionWhat(s) {
  if (s.extra) return 'Révision ajoutée par toi';
  const w = WORK[s.work] || WORK.review, rng = unitRange(s.work, s.chapters);
  const from = s.source_day ? ` du ${fmtShort(s.source_day)}` : '';
  const to = s.target ? ` · ${s.work === 'exam' ? 'pour' : 'avant'} ${s.work === 'exam' ? examNoun(s.target_kind) : 'le ' + kindNoun(s.target_kind)} du ${fmtShort(s.target.slice(0, 10))}` : '';
  return `${w.action}${from}${rng ? ' · ' + rng : ''}${to}`;
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
  const part = s.catchup ? ' · rattrapage' : (s.slot_count > 1 ? ` (${s.slot_index + 1}/${s.slot_count})` : '');
  const tone = s.status === 'done' ? 'opacity-60' : s.status === 'missed' ? 'bg-red-50' : 'bg-white';
  return `<li class="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-slate-200 ${tone}${draggable ? ' drag-card' : ''}" ${draggable ? `draggable="true" data-drag-sid="${esc(s.id)}" title="Glisse sur un autre jour pour déplacer"` : ''} style="border-left:5px solid ${esc(s.color)}">
    ${draggable ? '<span class="drag-handle" aria-hidden="true" title="Maintiens et glisse vers un autre jour">⠿</span>' : ''}
    <div class="flex-1 min-w-[12rem]">
      <p class="font-medium ${s.status === 'done' ? 'line-through' : ''}"><button type="button" class="subj-link" data-subj="${esc(s.subject)}" title="Ouvrir les cours de cette matière">${esc(s.subject)}</button>${part} ${workPill(s)} ${badges(s)}</p>
      <p class="text-xs text-slate-500">${withDay ? fmtShort(s.day) + ' · ' : ''}${hhmm(s.start)}–${hhmm(s.end)} (${fmtDur(s.minutes)}) · ${esc(sessionWhat(s))}</p>
    </div>
    ${statusButtons(s)}
    ${s.status === 'pending' ? `<button data-timer="${esc(s.id)}" class="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 shrink-0" title="Lancer un minuteur de ${s.minutes} min">▶ Commencer</button>` : ''}
    <button data-open-doc="${esc(s.id)}" class="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 shrink-0" title="Ouvrir le ${s.work === 'practice' ? 'TD' : 'cours'} à travailler">📂 Ouvrir</button>
    ${s.status === 'pending' ? `<button data-move="${esc(s.id)}" class="text-xs text-slate-500 hover:text-slate-900 underline shrink-0">Modifier</button>` : ''}
    ${s.extra ? `<button data-extra-del="${s.extra_id}" class="text-xs shrink-0" title="Supprimer ce créneau" aria-label="Supprimer ce créneau">🗑</button>` : ''}
  </li>`;
}

let sessionIndex = {};
function bindSessionActions(root) {
  $$('[data-status]', root).forEach(b => b.onclick = guard(async () => {
    const r = await api(`/api/sessions/${b.dataset.sid}`, { method: 'PATCH', json: { status: b.dataset.status } });
    logSession(b.dataset.sid, b.dataset.status); stopTimerFor(b.dataset.sid);
    const wasDone = b.dataset.status === 'done' && sessionIndex[b.dataset.sid];
    if (b.dataset.status === 'missed') toast(`Reporté au cycle suivant · retard de la matière : ${r.backlog}`);
    await refresh();
    if (wasDone) askConfidence(wasDone.subject, wasDone.work);
  }));
  $$('[data-move]', root).forEach(b => b.onclick = () => openMove(sessionIndex[b.dataset.move]));
  $$('[data-extra-del]', root).forEach(b => b.onclick = guard(async () => { await api(`/api/extras/${b.dataset.extraDel}`, { method: 'DELETE' }); toast('Créneau supprimé'); await refresh(); }));
  $$('[data-subj]', root).forEach(b => b.onclick = e => { e.stopPropagation(); openSubject(b.dataset.subj, view); });
  $$('[data-timer]', root).forEach(b => b.onclick = () => startTimer(sessionIndex[b.dataset.timer]));
  $$('[data-open-doc]', root).forEach(b => b.onclick = guard(async () => { reviewIntent = null; await openSessionDoc(sessionIndex[b.dataset.openDoc], view); }));
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
  renderBackupBanner().catch(() => {});
  renderPriorities().catch(() => {});
  renderExams().catch(() => {});
  renderCardsCard().catch(() => {});
  renderTasks();
  renderStats().catch(() => {});
  renderDueCard($('#review-card-dash')).catch(() => {});
  const [t, w, subs] = await Promise.all([api('/api/today'), api(`/api/week?start=${iso(monday(new Date()))}`), api('/api/subjects')]);
  $('#today-date').textContent = fmtLong(t.date);
  index(t.todo); index(t.upcoming);
  renderHero(t).catch(() => {}); renderOnboarding(subs.length);
  $('#todo-list').innerHTML = t.todo.length ? t.todo.map(s => sessionRow(s)).join('')
    : '<li class="text-sm text-slate-500 p-2">🎉 Rien à réviser aujourd\'hui. Si c\'est inattendu, vérifie que ton emploi du temps est bien importé.</li>';
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

/* ---------------------------------------------------------------- minuteur de séance */
const TIMER_KEY = 'campass-timer';
let timerTick = null;
const readTimer = () => { try { return JSON.parse(lsGet(TIMER_KEY) || 'null'); } catch { return null; } };
function startTimer(s) {
  if (!s) return;
  lsSet(TIMER_KEY, JSON.stringify({ sid: s.id, subject: s.subject, work: s.work, minutes: s.minutes, end: Date.now() + s.minutes * 60000 }));
  renderTimer();
}
function stopTimerFor(sid) { const t = readTimer(); if (t && t.sid === sid) { lsDel(TIMER_KEY); renderTimer(); } }
function renderTimer() {
  const bar = $('#timer-bar'), t = readTimer();
  clearInterval(timerTick); timerTick = null;
  if (!t) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  const w = WORK[t.work] || WORK.review;
  const paint = () => {
    const left = t.end - Date.now();
    if (left > 0) {
      const m = Math.floor(left / 60000), sec = Math.floor(left % 60000 / 1000);
      bar.className = 'timer-bar'; bar.innerHTML = `<span>${w.icon} <b>${esc(t.subject)}</b></span><b class="timer-clock">${m}:${String(sec).padStart(2, '0')}</b>
        <button type="button" class="quiet" id="tm-stop">Arrêter</button>`;
    } else {
      bar.className = 'timer-bar done'; bar.innerHTML = `<span>⏰ <b>${esc(t.subject)}</b> : c'est terminé !</span>
        <button type="button" class="primary" id="tm-done">✓ Fait</button><button type="button" class="quiet" id="tm-stop">Pas fini</button>`;
      clearInterval(timerTick); timerTick = null;
      if (!t.notified) { lsSet(TIMER_KEY, JSON.stringify({ ...t, notified: true })); toast(`⏰ ${t.subject} : temps écoulé`); notify('⏰ Temps écoulé', t.subject, 'timer'); }
    }
    $('#tm-stop').onclick = () => { lsDel(TIMER_KEY); renderTimer(); };
    const d = $('#tm-done');
    if (d) d.onclick = guard(async () => {
      await api(`/api/sessions/${t.sid}`, { method: 'PATCH', json: { status: 'done' } });
      if (!sessionIndex[t.sid]) sessionIndex[t.sid] = { id: t.sid, subject: t.subject, minutes: t.minutes };
      logSession(t.sid, 'done'); lsDel(TIMER_KEY); renderTimer(); toast('Créneau marqué comme fait'); await refresh(); askConfidence(t.subject, t.work);
    });
  };
  paint(); if (t.end > Date.now()) timerTick = setInterval(paint, 1000);
}

/* ---------------------------------------------------------------- tâches du jour (cases à cocher des notes) */
const TASK_RE = /^(\s*[-*]\s*)\[([ xX])\]\s?(.*)$/;
function renderTasks() {
  const card = $('#tasks-card'), day = todayIso(), text = readNotes().days[day] || '';
  const lines = text.split('\n'), tasks = [];
  lines.forEach((l, i) => { const m = l.match(TASK_RE); if (m && m[3].trim()) tasks.push({ i, done: m[2] !== ' ', label: m[3].trim() }); });
  card.classList.toggle('hidden', !tasks.length);
  if (!tasks.length) return;
  const left = tasks.filter(t => !t.done).length;
  $('#tasks-sub').textContent = left ? `${left} à faire` : 'tout est fait 🎉';
  $('#tasks-list').innerHTML = tasks.map(t => `<li><label class="task-row ${t.done ? 'done' : ''}"><input type="checkbox" data-line="${t.i}" ${t.done ? 'checked' : ''}> <span>${esc(t.label)}</span></label></li>`).join('');
  $$('#tasks-list input').forEach(c => c.onchange = () => {
    const n = readNotes(), ls = (n.days[day] || '').split('\n'), i = Number(c.dataset.line), m = ls[i] && ls[i].match(TASK_RE);
    if (!m) return;
    ls[i] = `${m[1]}[${c.checked ? 'x' : ' '}] ${m[3]}`; n.days[day] = ls.join('\n');
    writeNotes(n); renderTasks();
  });
}

/** Carte « Examens à venir » : compte à rebours et avancement des révisions. */
async function renderExams() {
  const card = $('#exam-card'), list = await api('/api/exams');
  $('#exam-empty').classList.toggle('hidden', !!list.length);
  $('#exam-subjects').innerHTML = (await api('/api/subjects')).map(x => `<option value="${esc(x.name)}">`).join('');
  $('#exam-list').innerHTML = list.slice(0, 5).map(x => {
    const pct = x.sessions_total ? Math.round(100 * x.sessions_done / x.sessions_total) : 0;
    const left = x.days_left === 0 ? 'aujourd\'hui' : x.days_left === 1 ? 'demain' : `dans ${x.days_left} j`;
    return `<li class="exam-item" style="border-left-color:${esc(x.color)}"><span class="exam-count ${x.days_left <= 7 ? 'soon' : ''}">${left}</span>
      <div class="min-w-0 flex-1"><button type="button" class="subj-link font-medium" data-subj="${esc(x.subject)}">${esc(x.subject)}</button>
        <span class="text-xs text-slate-500"> · ${esc(x.kind || 'Examen')} ${fmtShort(x.day)} ${hhmm(x.start)}</span>
        ${x.cid ? `<button type="button" class="text-xs" data-exam-edit="${x.cid}" title="Modifier" aria-label="Modifier">✏️</button> <button type="button" class="text-xs" data-exam-del="${x.cid}" title="Supprimer" aria-label="Supprimer">🗑</button>` : ''}
        <div class="h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden"><div class="h-full bg-red-400" style="width:${pct}%"></div></div>
        <p class="text-xs text-slate-500 mt-0.5">${x.sessions_total ? `${x.sessions_done}/${x.sessions_total} créneaux faits · reste ${fmtDur(x.minutes_left)}` : 'aucun créneau prévu'}</p></div></li>`;
  }).join('');
  bindSessionActions(card);
  $$('#exam-list [data-exam-del]').forEach(b => b.onclick = guard(async () => {
    await api(`/api/custom-courses/${b.dataset.examDel}`, { method: 'DELETE' }); toast('Interro supprimée'); await refreshAfterExam();
  }));
  $$('#exam-list [data-exam-edit]').forEach(b => b.onclick = () => {
    const x = list.find(e => String(e.cid) === b.dataset.examEdit), f = $('#exam-form');
    f.subject.value = x.subject; f.kind.value = [...f.kind.options].some(o => o.value === x.kind) ? x.kind : 'Interro';
    f.from.value = x.day; f.start.value = hhmm(x.start);
    const mins = (Number(x.end.slice(11, 13)) * 60 + Number(x.end.slice(14, 16))) - (Number(x.start.slice(11, 13)) * 60 + Number(x.start.slice(14, 16)));
    f.duration.value = [...f.duration.options].some(o => Number(o.value) === mins) ? String(mins) : '120';
    examEditing = x.cid; $('#exam-save').textContent = 'Enregistrer'; $('#exam-cancel').classList.remove('hidden');
    $('#exam-add').open = true; f.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}
let examEditing = 0;
const refreshAfterExam = () => loadDashboard();
const resetExamForm = () => { examEditing = 0; $('#exam-form').reset(); $('#exam-save').textContent = 'Programmer'; $('#exam-cancel').classList.add('hidden'); };
$('#exam-cancel').onclick = resetExamForm;
$('#exam-form').onsubmit = guard(async e => {
  e.preventDefault();
  const f = e.target, [h, m] = f.start.value.split(':').map(Number), endMin = Math.min(h * 60 + m + Number(f.duration.value), 23 * 60 + 59);
  if (h * 60 + m >= endMin) throw new Error('Choisis une heure plus tôt dans la journée.');
  const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  await api('/api/custom-courses', { method: 'POST', json: { subject: f.subject.value, kind: f.kind.value, from: f.from.value, start: f.start.value, end, frequency: 'once' } });
  if (examEditing) await api(`/api/custom-courses/${examEditing}`, { method: 'DELETE' });
  toast(examEditing ? 'Interro modifiée' : 'Interro programmée'); resetExamForm(); await refreshAfterExam();
});

/** Carte « À réviser en priorité » : retards d'abord, puis prochain cours le plus proche. */
async function renderPriorities() {
  const card = $('#priority-card');
  const [a, counts] = await Promise.all([api('/api/agenda'), library.counts().catch(() => ({}))]);
  const list = prioritize(a.sessions, todayIso()).slice(0, 5);
  card.classList.toggle('hidden', !list.length);
  if (!list.length) return;
  $('#priority-sub').textContent = plural(list.length, 'matière', 'matières');
  $('#priority-list').innerHTML = list.map((g, i) => {
    const n = counts[fold(g.subject)] || 0;
    const parts = [g.late ? `${plural(g.late, 'créneau', 'créneaux')} à rattraper (${fmtDur(g.lateMinutes)})` : '',
                   g.nextTarget ? `prochaine séance ${fmtShort(g.nextTarget.slice(0, 10))}` : '',
                   g.learn ? `${WORK.learn.icon} ${g.learn} à apprendre` : '', g.practice ? `${WORK.practice.icon} ${g.practice} en exercices` : ''].filter(Boolean);
    return `<li class="prio-item" style="border-left-color:${esc(g.color)}"><span class="rank">${i + 1}</span>
      <div class="min-w-0 flex-1"><button type="button" class="subj-link font-medium" data-subj="${esc(g.subject)}" title="Ouvrir les cours de cette matière">${esc(g.subject)}</button>
        ${g.late ? '<span class="late">en retard</span>' : ''}<p class="text-xs text-slate-500">${esc(parts.join(' · '))}</p></div>
      <span class="text-xs text-slate-500" title="Cours téléversés">${n ? `📎 ${n}` : 'aucun cours ajouté'}</span></li>`;
  }).join('');
  bindSessionActions(card);
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
      const ct = workType(c.kind), ci = ct === 'learn' ? WORK.learn.icon : ct === 'practice' ? WORK.practice.icon : '';
      ev.push(`<div class="ev course" role="button" tabindex="0" data-subj="${esc(c.subject)}" style="top:${top}px;height:${h}px;background:${esc(c.color)}22;border-left:4px solid ${esc(c.color)}"
        title="${esc(c.summary)} — clique pour ouvrir / ajouter les cours de cette matière">
        <b>${esc(c.subject)}</b> ${ci} ${esc(c.kind)}${nDocs ? ` <span class="doc-count">📎 ${nDocs}</span>` : ''}<br>${hhmm(c.start)}–${hhmm(c.end)}${c.room ? ' · ' + esc(c.room) : ''}</div>`);
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
      ev.push(`<div class="ev rev ${s.status} work-${esc(s.work)}" draggable="true" data-sid="${esc(s.id)}" title="${esc(s.subject + ' : ' + sessionWhat(s))}" style="top:${top}px;height:${h}px;border-color:${esc(s.color)};color:${esc(s.color)}">
        <b data-subj="${esc(s.subject)}" class="subj-link" title="Ouvrir les cours de cette matière">${s.catchup ? '↻' : ''}${(WORK[s.work] || WORK.review).icon} ${esc(s.subject)}</b>${s.overloaded ? ' ⚠️' : ''}<br>${hhmm(s.start)}–${hhmm(s.end)} ${acts}</div>`);
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
  const late = a.sessions.filter(s => s.overdue), lateBox = $('#agenda-late');
  lateBox.classList.toggle('hidden', !late.length);
  if (late.length) {
    lateBox.innerHTML = `<span class="grow-text">⏰ <b>${plural(late.length, 'créneau', 'créneaux')} en retard</b> (${fmtDur(late.reduce((n, x) => n + x.minutes, 0))}).
      Déplace-les un par un, ou laisse-moi les répartir sur les prochains jours les moins chargés.</span>
      <button type="button" id="replan-all">Tout replacer automatiquement</button>`;
    $('#replan-all').onclick = e => { e.target.disabled = true; replanLate().finally(() => { e.target.disabled = false; }); };
  }
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
      <ul class="space-y-2">${list.map(s => sessionRow(s, false, s.status === 'pending')).join('')}</ul>
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
      await moveSessionToDay(sessionIndex[e.dataTransfer.getData('text/plain')], day.dataset.day);
    });
  });
  bindTouchDrag(root);
}
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const weekFor = day => api(`/api/week?start=${iso(monday(parseDay(day)))}`);
/** Déplace un créneau sur un jour : on garde son heure si elle est libre, sinon le premier créneau libre de la journée. */
const moveSessionToDay = guard(async (s, day) => {
  if (!s || s.day === day) return;
  const w = await weekFor(day);
  const slot = freeSlot(busyIntervals(w, day, s.id), s.minutes,
    { dayStart: w.day_start, dayEnd: w.day_end, prefer: hhmm(s.start), notBefore: day === todayIso() ? nowMin() : 0 });
  await api(`/api/sessions/${s.id}`, { method: 'PATCH', json: { day, start: slot || hhmm(s.start) } });
  toast(slot ? `« ${s.subject} » déplacée au ${fmtShort(day)} à ${slot}` : `« ${s.subject} » déplacée au ${fmtShort(day)} (journée pleine : heure conservée)`, !!slot);
  await refresh();
});

/** « Tout replacer » : répartit les créneaux en retard sur les 14 prochains jours, les moins chargés d'abord. */
const replanLate = guard(async () => {
  const late = (await api('/api/agenda')).sessions.filter(s => s.overdue).sort((a, b) => a.target.localeCompare(b.target));
  if (!late.length) return;
  if (!confirm(`Répartir ${late.length} créneau${late.length > 1 ? 'x' : ''} en retard sur les 14 prochains jours, en commençant par les jours les moins chargés ?`)) return;
  const weeks = {}, days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const k = iso(d), m = iso(monday(d));
    const w = weeks[m] ||= await api(`/api/week?start=${m}`);
    const l = w.load[k];
    days.push({ day: k, load: l ? l.minutes : 0, capacity: l ? l.capacity : 180, busy: busyIntervals(w, k), notBefore: i === 0 ? nowMin() : 0 });
  }
  const any = Object.values(weeks)[0];
  const r = spreadSessions(late.map(s => ({ id: s.id, minutes: s.minutes, start: hhmm(s.start) })), days, { dayStart: any.day_start, dayEnd: any.day_end });
  for (const m of r.moves) await api(`/api/sessions/${m.id}`, { method: 'PATCH', json: { day: m.day, start: m.start } });
  const extra = [r.over ? `${r.over} dépasse${r.over > 1 ? 'nt' : ''} la charge conseillée` : '', r.unplaced.length ? `${r.unplaced.length} sans place` : ''].filter(Boolean).join(' · ');
  toast(`${plural(r.moves.length, 'créneau replacé', 'créneaux replacés')}${extra ? ' · ' + extra : ''}`, !r.unplaced.length);
  await refresh();
});

/** Doigt / stylet : la souris utilise le glisser-déposer natif, le tactile passe par la poignée ⠿ (qui ne bloque pas le défilement ailleurs). */
function bindTouchDrag(root) {
  $$('.drag-handle', root).forEach(h => {
    h.onpointerdown = e => {
      if (e.pointerType === 'mouse') return;
      const card = h.closest('[data-drag-sid]'), s = sessionIndex[card.dataset.dragSid];
      if (!s) return;
      e.preventDefault();
      card.draggable = false;                                   // évite le glisser natif d'iOS en parallèle
      h.setPointerCapture(e.pointerId);
      const r = card.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const ghost = card.cloneNode(true);
      ghost.classList.add('drag-ghost'); ghost.style.width = r.width + 'px';
      document.body.appendChild(ghost);
      card.classList.add('dragging'); root.classList.add('is-dragging');
      let x = e.clientX, y = e.clientY, over = null;
      const place = () => {
        ghost.style.left = (x - dx) + 'px'; ghost.style.top = (y - dy) + 'px';
        const el = document.elementFromPoint(x, y)?.closest('.agenda-day.droppable');
        if (el !== over) { over?.classList.remove('drop-over'); over = el; over?.classList.add('drop-over'); }
      };
      place();
      const auto = setInterval(() => {                           // défilement automatique près des bords de l'écran
        const edge = 90;
        if (y < edge) scrollBy(0, -14); else if (y > innerHeight - edge) scrollBy(0, 14); else return;
        place();
      }, 16);
      h.onpointermove = ev => { x = ev.clientX; y = ev.clientY; place(); };
      const end = async ev => {
        clearInterval(auto);
        h.onpointermove = h.onpointerup = h.onpointercancel = null;
        try { h.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
        const target = ev.type === 'pointerup' ? over : null;
        ghost.remove(); card.classList.remove('dragging'); root.classList.remove('is-dragging');
        $$('.agenda-day', root).forEach(d => d.classList.remove('drop-over'));
        card.draggable = true;
        if (target) await moveSessionToDay(s, target.dataset.day);
      };
      h.onpointerup = end; h.onpointercancel = end;
    };
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
      ${confLine(s)}
      <details class="subj-settings"><summary>Réglages du planning</summary>
        <div class="grid grid-cols-2 gap-3">
          ${num('session_minutes', 'Durée d\'une session (min)', s.session_minutes, 5, 480, 5)}
          ${num('practice_minutes', 'Durée d\'une session de TD (0 = idem)', s.practice_minutes || 0, 0, 480, 5)}
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
  const last = lsGet(BK_KEY), bl = $('#backup-last');
  bl.className = `text-sm mb-3 ${last && ageDays(last) < 7 ? 'text-emerald-700' : 'text-amber-700'}`;
  bl.textContent = last ? `Dernière sauvegarde : ${new Date(last).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}.` : '⚠️ Aucune sauvegarde faite depuis cet appareil.';
  const blocks = await api('/api/blocks');
  $('#blocks-list').innerHTML = blocks.length ? blocks.map(b => `<li class="flex items-center gap-2">⛔ ${fmtShort(b.day)} ${esc(b.start)}–${esc(b.end)} ${esc(b.label)}
    <button data-del="${b.id}" class="ml-auto text-red-600 hover:underline text-xs">Supprimer</button></li>`).join('') : '<li class="text-slate-400">Aucun blocage.</li>';
  $$('#blocks-list [data-del]').forEach(b => b.onclick = guard(async () => { await api(`/api/blocks/${b.dataset.del}`, { method: 'DELETE' }); await loadSync(); }));

  const rblocks = await api('/api/recurring-blocks');
  $('#rblocks-list').innerHTML = rblocks.length ? rblocks.map(b => `<li class="flex items-center gap-2">🔁 ${esc(daysLabel(b.weekdays))} ${esc(b.start)}–${esc(b.end)} ${esc(b.label)}
    <span class="text-xs text-slate-400">${esc(rangeLabel(b.from, b.until))}</span>
    <button data-del="${b.id}" class="ml-auto text-red-600 hover:underline text-xs">Supprimer</button></li>`).join('') : '<li class="text-slate-400">Aucun blocage hebdomadaire.</li>';
  $$('#rblocks-list [data-del]').forEach(b => b.onclick = guard(async () => { await api(`/api/recurring-blocks/${b.dataset.del}`, { method: 'DELETE' }); await loadSync(); }));

  const all = await api('/api/custom-courses');
  const courses = all.filter(c => !c.from_name), shared = {};
  all.filter(c => c.from_name).forEach(c => { shared[c.from_name] = (shared[c.from_name] || 0) + 1; });
  const sharedHtml = Object.entries(shared).map(([n, k]) => `<li class="flex items-center gap-2">👥 <b>${esc(n)}</b> <span class="text-xs text-slate-500">${plural(k, 'cours reçu', 'cours reçus')}</span>
    <button data-unshare="${esc(n)}" class="ml-auto text-red-600 hover:underline text-xs">Retirer</button></li>`).join('');
  $('#courses-list').innerHTML = sharedHtml + (courses.length ? courses.map(c => `<li class="flex items-center gap-2">📘 <b>${esc(c.subject)}</b> ${esc(c.kind)} ${esc(c.start)}–${esc(c.end)}
    <span class="text-xs text-slate-500">${esc(courseFreq(c))}</span>
    <button data-del="${c.id}" class="ml-auto text-red-600 hover:underline text-xs">Supprimer</button></li>`).join('') : (sharedHtml ? '' : '<li class="text-slate-400">Aucun cours ajouté.</li>'));
  $$('#courses-list [data-unshare]').forEach(b => b.onclick = guard(async () => { await api(`/api/shared-courses/${encodeURIComponent(b.dataset.unshare)}`, { method: 'DELETE' }); await loadSync(); }));
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
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
/* ---- stockage léger du navigateur (notes, date de sauvegarde) : jamais bloquant */
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
const lsDel = k => { try { localStorage.removeItem(k); } catch { /* ignoré */ } };
const STATS_KEY = 'campass-stats:v1';
const readLog = () => { try { return cleanLog(JSON.parse(lsGet(STATS_KEY) || '{}')); } catch { return {}; } };
const writeLog = l => lsSet(STATS_KEY, JSON.stringify(l));
/** Journal des créneaux faits (pour les statistiques) : appelé à chaque changement d'état. */
function logSession(sid, status) {
  const l = readLog(), s = sessionIndex[sid];
  if (status === 'done' && s) l[sid] = { d: todayIso(), subject: s.subject, minutes: s.minutes }; else delete l[sid];
  writeLog(l);
}
const BK_KEY = 'campass-last-export', SNOOZE_KEY = 'campass-backup-snooze';
const NOTES_KEY = 'campass-notes:v1', FREE_KEY = 'campass.feuille-blanche';      // même clé que la page feuille-blanche.html

function readNotes() {
  let days = {};
  try { const o = JSON.parse(lsGet(NOTES_KEY) || '{}'); if (o && typeof o.days === 'object' && o.days) days = o.days; } catch { /* notes illisibles : on repart de zéro */ }
  return { days, free: lsGet(FREE_KEY) || '' };
}
function cleanNotes(n) {                                    // données importées : on ne garde que des dates et du texte
  const days = {};
  for (const [k, v] of Object.entries(n && n.days && typeof n.days === 'object' ? n.days : {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'string' && v.trim()) days[k] = v.slice(0, 100000);
  }
  return { days, free: typeof (n && n.free) === 'string' ? n.free.slice(0, 500000) : '' };
}
function writeNotes(n) { const ok = lsSet(NOTES_KEY, JSON.stringify({ days: n.days })); return lsSet(FREE_KEY, n.free || '') && ok; }

const ageDays = isoStr => (Date.now() - new Date(isoStr).getTime()) / 864e5;
async function exportBackup() {
  const { text } = await api('/api/export');
  const out = JSON.parse(text);
  out.notes = readNotes();                                  // les notes voyagent avec la sauvegarde
  out.stats = readLog(); out.goal = readGoal(); out.friends = readFriends();
  download(`revisions-campass-${iso(new Date())}.json`, JSON.stringify(out, null, 2));
  lsSet(BK_KEY, new Date().toISOString()); lsDel(SNOOZE_KEY);
  toast('Sauvegarde exportée');
}
$('#btn-export').onclick = guard(async () => { await exportBackup(); await loadSync(); });

async function renderBackupBanner() {
  const el = $('#backup-banner');
  const hasData = (await api('/api/subjects')).length > 0 || Object.keys(readNotes().days).length > 0;
  const last = lsGet(BK_KEY), age = last ? ageDays(last) : Infinity, snooze = lsGet(SNOOZE_KEY);
  if (!hasData || age < 7 || (snooze && snooze > todayIso())) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.className = 'backup-banner';
  el.innerHTML = `<span class="grow">💾 <b>${last ? `Dernière sauvegarde il y a ${Math.floor(age)} jours.` : 'Tu n\'as encore jamais sauvegardé tes données.'}</b>
    Elles ne sont que sur cet appareil : si le navigateur est vidé, elles disparaissent.</span>
    <button type="button" class="primary" id="bk-now">Sauvegarder maintenant</button>
    <button type="button" class="quiet" id="bk-later">Plus tard</button>`;
  $('#bk-now').onclick = guard(async () => { await exportBackup(); await renderBackupBanner(); });
  $('#bk-later').onclick = () => { const d = new Date(); d.setDate(d.getDate() + 2); lsSet(SNOOZE_KEY, iso(d)); renderBackupBanner(); };
}

$('#btn-ics-export').onclick = guard(async () => {
  const a = await api('/api/agenda');
  const { text, count } = buildIcs(a.sessions, { today: todayIso(), alarmMinutes: Number($('#ics-alarm').value) });
  if (!count) throw new Error('Aucun créneau de révision à venir à exporter.');
  download(`revisions-campass-${iso(new Date())}.ics`, text, 'text/calendar;charset=utf-8');
  toast(`${plural(count, 'créneau exporté', 'créneaux exportés')} : ouvre le fichier pour l'ajouter à ton calendrier`);
});
$('#import-file').onchange = guard(async e => {
  const f = e.target.files[0]; if (!f) return;
  const text = await readFile(f);
  e.target.value = '';
  if (!confirm('Remplacer toutes les données de cet appareil par cette sauvegarde ?')) return;
  await api('/api/import', { method: 'POST', json: { text } });
  try { const j = JSON.parse(text); if (j.notes) writeNotes(cleanNotes(j.notes)); if (j.stats) writeLog(cleanLog(j.stats)); if (j.goal) lsSet(GOAL_KEY, String(Math.round(Number(j.goal)) || 0)); if (j.friends && typeof j.friends === 'object') lsSet(FRIENDS_KEY, JSON.stringify(j.friends)); } catch { /* sauvegarde sans notes */ }
  toast('Sauvegarde restaurée'); await refresh();
});
$('#btn-reset').onclick = guard(async () => {
  if (!confirm('Effacer toutes les données de cet appareil (planning, cours téléversés, notes, clé de l\'assistant) ? Pense à exporter une sauvegarde avant.')) return;
  await api('/api/reset', { method: 'POST' });
  await library.clear(); AI.clearSettings(); lsDel(NOTES_KEY); lsDel(FREE_KEY); lsDel(STATS_KEY); lsDel(TIMER_KEY); lsDel(GOAL_KEY); lsDel(GOALHIT_KEY); lsDel(FRIENDS_KEY); lsDel(NAME_KEY); lsDel(BK_KEY); lsDel(SNOOZE_KEY);
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
  const docRow = d => `<li class="flex items-center gap-3 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-400" style="border-left:5px solid ${esc(s.color)}">
      <button data-doc="${d.id}" class="flex-1 min-w-0 text-left">
        <p class="font-medium truncate">${KIND_ICON[d.kind] || '📄'} ${esc(d.name)} ${d.has_summary ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 align-middle">✨ résumé</span>' : ''}
          ${d.srs ? `<span class="text-[10px] px-1.5 py-0.5 rounded align-middle ${d.srs.due <= iso(new Date()) ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}">🔁 ${esc(SRS.dueLabel(d.srs.due, iso(new Date())))}</span>` : ''}</p>
        <p class="text-xs text-slate-500">${fmtSize(d.size)} · ajouté le ${new Date(d.added).toLocaleDateString('fr-FR')}${d.messages ? ` · ${d.messages} message${d.messages > 1 ? 's' : ''}` : ''}</p>
      </button>
      <button data-topic="${d.id}" data-to="${d.topic === 'td' ? 'cours' : 'td'}" class="text-xs text-slate-500 hover:underline shrink-0" title="Corriger le type de ce document">${d.topic === 'td' ? '→ c\'est un cours' : '→ c\'est un TD'}</button>
      <button data-rm="${d.id}" data-name="${esc(d.name)}" class="text-xs text-red-600 hover:underline shrink-0">Supprimer</button></li>`;
  const groups = [['cours', 'learn', 'Cours', 'à apprendre'], ['td', 'practice', 'TD & exercices', 'à travailler']];
  const html = groups.map(([topic, work, title, sub]) => {
    const list = docs.filter(d => (d.topic === 'td' ? 'td' : 'cours') === topic);
    return list.length ? `<li class="docs-head"><span class="work-pill ${work}">${WORK[work].icon} ${title}</span><small>${sub} · ${list.length}</small></li>${list.map(docRow).join('')}` : '';
  }).join('');
  $('#docs-list').innerHTML = html || '<li class="text-sm text-slate-400 p-2">Aucun document pour le moment. Ajoute ton premier cours ou TD ci-dessus.</li>';
  $$('#docs-list [data-doc]').forEach(b => b.onclick = () => show('doc', b.dataset.doc));
  $$('#docs-list [data-topic]').forEach(b => b.onclick = guard(async () => {
    await library.update(b.dataset.topic, { topic: b.dataset.to }); await loadSubject(name);
  }));
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
        const pick = $('#doc-topic').value;
        await library.add({ subject: currentSubject.name, name: f.name, kind, size: f.size, text, blob: f, topic: pick === 'auto' ? guessTopic(f.name) : pick });
        added++;
      } catch (e) { errors.push(`${f.name} : ${e.message}`); }
    }
  } finally { zone.classList.remove('busy'); label.textContent = 'Ajouter des cours ou des TD'; }
  if (added) toast(`${added} document${added > 1 ? 's ajoutés' : ' ajouté'}${errors.length ? ` · ${errors.length} refusé${errors.length > 1 ? 's' : ''}` : ''}`);
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
  const QA = T().quick;
  $('#ai-suggest').innerHTML = QA.map((a, i) => `<li><button type="button" data-qa="${i}"><span aria-hidden="true">${a.icon}</span>${esc(a.label)}</button></li>`).join('');
  $('#ai-quick').innerHTML = n ? QA.map((a, i) => `<button type="button" data-qa="${i}">${a.icon} ${esc(a.label)}</button>`).join('') : '';
  $$('#ai-suggest [data-qa], #ai-quick [data-qa]').forEach(b => b.onclick = () => sendQuestion(QA[b.dataset.qa].prompt));
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
  el.textContent = busyText || (doc && doc.ai_off ? 'Sans lecture du cours' : doc && doc.ai_extracts ? 'Extraits · ' + c.model : c.key ? c.model : 'Clé API à ajouter');
}
const T = () => AI.forTopic(doc && doc.topic);
/** Le texte du cours n'est envoyé à l'IA que si elle est autorisée à le lire : toutes les fonctions d'IA passent par ici. */
const aiAllowed = () => !(doc && doc.ai_off);
/** 'full' : tout le cours · 'extracts' : seulement les passages liés à la question · 'off' : rien */
const aiMode = () => doc && doc.ai_off ? 'off' : doc && doc.ai_extracts ? 'extracts' : 'full';
const aiContext = () => {
  if (!aiAllowed()) throw new AI.AiError('L\'IA ne lit pas ce cours : rien n\'est envoyé. Réactive-la avec le bouton « IA » de l\'assistant.', 'off');
  return T().system({ subject: doc.subject_name, title: doc.name, text: doc.text });
};
const extractsContext = q => {
  const prev = [...doc.chat].reverse().find(m => m.role === 'user' && m.content !== q);
  return AI.systemPromptExcerpts({ subject: doc.subject_name, title: doc.name, excerpts: AI.selectExcerpts(doc.text, q + ' ' + (prev ? prev.content : '')) });
};
/** Interrupteur « L'IA lit ce cours » : état du bouton, saisie et raccourcis de l'assistant. */
function applyAiMode() {
  const on = aiAllowed(), m = aiMode(), b = $('#ai-toggle');
  b.classList.toggle('off', !on); b.setAttribute('aria-pressed', String(on));
  b.innerHTML = m === 'full' ? '🤖 IA : lit tout le cours' : m === 'extracts' ? '✂️ IA : extraits seulement' : '🔒 IA : ne lit pas';
  b.title = m === 'full' ? 'Clique pour n\'envoyer à l\'IA que les extraits liés à tes questions' : m === 'extracts' ? 'Clique pour empêcher l\'IA de lire ce cours (aucun texte ne sera envoyé)' : 'Clique pour autoriser l\'IA à lire tout le cours';
  $('#ai-input').disabled = false; $('#ai-send').disabled = aiBusy;
  $('#ai-input').placeholder = on ? 'Pose ta question…' : 'Question générale (l\'IA ne voit pas ton cours)…';
  $$('#ai-suggest button, #ai-quick button').forEach(x => { x.disabled = !on; });
  $('#review-quiz').disabled = !on || !aiConfig().key;
  updateAiStatus();
}
$('#ai-toggle').onclick = guard(async () => {
  if (!doc) return;
  const next = { full: 'extracts', extracts: 'off', off: 'full' }[aiMode()];
  doc.ai_off = next === 'off'; doc.ai_extracts = next === 'extracts';
  await library.update(doc.id, { ai_off: doc.ai_off, ai_extracts: doc.ai_extracts });
  applyAiMode();
  toast({ full: 'L\'IA peut lire tout le cours', extracts: 'L\'IA ne reçoit que les extraits liés à tes questions', off: 'L\'IA ne lit plus ce cours : rien ne lui est envoyé' }[next]);
  if (next === 'off') { if (!doc.summary) renderSummary('off'); } else autoSummarize();
});
/** Textes qui changent selon que le document est un cours (à apprendre) ou un TD (exercices). */
function applyTopicTexts() {
  const t = T();
  $('.ai-summary summary').textContent = t.summaryTitle;
  $('#ai-empty p').textContent = t.emptyIntro;
  $('#review-quiz').textContent = t.quizBtn; $('#review-reread').textContent = t.rereadBtn;
  $('#review-choice p').innerHTML = t.reviewIntro; $('#review-grade p').innerHTML = t.gradeIntro;
}

function renderSummary(state, msg = '') {
  const el = $('#ai-summary'), btn = $('#ai-resum');
  btn.classList.toggle('hidden', !(doc && doc.summary) || aiBusy || !aiAllowed());
  if (state !== 'ready') el.closest('details').open = true;
  if (state === 'ready') el.innerHTML = mdToHtml(doc.summary);
  else if (state === 'loading') el.innerHTML = '<span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="sr-only">Lecture du cours en cours</span>';
  else if (state === 'off') el.innerHTML = `<p class="text-slate-600">🔒 L'IA ne lit pas ce cours : aucun texte n'est envoyé. Tu peux toujours lire le document, créer tes fiches à la main et utiliser le rappel libre.</p>
      <button type="button" data-allow class="tool mt-3">Autoriser l'IA à le lire</button>`;
  else if (state === 'extracts') el.innerHTML = `<p class="text-slate-600">✂️ Mode extraits : pour chaque question, seuls les passages du cours qui s'y rapportent sont envoyés à l'IA (pas de résumé automatique).</p>
      <button type="button" data-fullsum class="tool mt-3">Résumer tout le cours quand même</button>`;
  else if (state === 'nokey') el.innerHTML = `<p class="text-slate-600">${esc(T().noKey)}</p>
      <button type="button" data-config class="tool tool-primary mt-3">Ajouter ma clé</button>`;
  else el.innerHTML = `<p class="text-red-700" role="alert">${esc(msg)}</p><button type="button" data-retry class="tool mt-3">Réessayer</button>`;
  $('[data-config]', el)?.addEventListener('click', openAiSettings);
  $('[data-allow]', el)?.addEventListener('click', () => $('#ai-toggle').click());
  $('[data-retry]', el)?.addEventListener('click', () => summarize());
  $('[data-fullsum]', el)?.addEventListener('click', () => summarize());
}
/** Résumé automatique à l'ouverture : sauf en mode extraits (qui évite d'envoyer tout le cours). */
function autoSummarize() {
  if (aiMode() === 'extracts') return renderSummary(doc.summary ? 'ready' : 'extracts');
  if (doc.summary) return renderSummary('ready');
  if (!aiBusy) summarize(); else renderSummary('nokey');
}

async function summarize() {
  const cfg = aiConfig(), token = docToken;
  if (!aiAllowed()) return renderSummary('off');
  if (!cfg.key) return renderSummary('nokey');
  aiBusy = true; renderSummary('loading'); updateAiStatus('Lit le cours…');
  try {
    const text = await AI.ask(cfg, { system: aiContext(), messages: [{ role: 'user', content: T().summaryRequest }] });
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
  const general = !aiAllowed();
  const cfg = aiConfig(), token = docToken;
  if (!cfg.key) return openAiSettings();
  aiBusy = true; $('#ai-send').disabled = true; updateAiStatus('Réfléchit…');
  doc.chat.push({ role: 'user', content: text, ...(general ? { g: 1 } : {}) });
  renderChat(); typing(true);
  try {
    // IA coupée : on n'envoie ni le texte du cours ni les anciennes réponses qui le citent, seulement les échanges « généraux »
    const answer = await AI.ask(cfg, general
      ? { system: AI.generalPrompt(), messages: doc.chat.filter(m => m.g) }
      : { system: aiMode() === 'extracts' ? extractsContext(text) : aiContext(), messages: doc.chat });
    if (token !== docToken) return;
    doc.chat.push({ role: 'assistant', content: answer, ...(general ? { g: 1 } : {}) });
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
    if (token === docToken) { aiBusy = false; $('#ai-send').disabled = false; typing(false); updateAiStatus(); renderSummary(doc.summary ? 'ready' : aiMode() === 'extracts' ? 'extracts' : aiAllowed() ? 'nokey' : 'off'); scrollChat(); }
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
  const parts = [d.topic === 'td' ? `<span class="work-pill practice">${WORK.practice.icon} TD · exercices</span>` : `<span class="work-pill learn">${WORK.learn.icon} Cours</span>`,
                 `<span>${KIND_LABEL[d.kind] || 'Document'}</span>`];
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
  applySize(); applyTopicTexts();
  renderReader(d.text); renderChat(); applyAiMode();
  window.scrollTo({ top: 0 }); $('#doc-article').scrollTop = 0; updateProgress();
  setupPdf(d, docToken);
  renderSrs();
  if (reviewIntent === String(d.id) && d.srs) showReviewBar(); else hideReviewBar();
  autoSummarize();
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
    if (!doc.summary && !aiBusy) autoSummarize();
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
    row.innerHTML = `<button type="button" id="srs-start" class="tool">${esc(T().srsStart)}</button>
      <label class="srs-hint">le <input type="date" id="srs-date" value="${today}" max="${today}" class="srs-date"></label>
      <span class="srs-hint">${esc(T().srsHint)}</span>`;
    $('#srs-start').onclick = guard(async () => {
      const day = /^\d{4}-\d{2}-\d{2}$/.test($('#srs-date').value) && $('#srs-date').value <= todayIso() ? $('#srs-date').value : todayIso();
      doc.srs = await updateSrs(doc.id, () => SRS.startCard(day)); doc.cards_paused = false; await library.update(doc.id, { cards_paused: false });
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
    const hasCards = cleanCards(doc.cards).length > 0;
    if (!confirm(T().srsStop + (hasCards ? '\n\nLes fiches mémoire de ce cours sont aussi mises en pause (tu pourras les réactiver dans « 🃏 Fiches »).' : ''))) return;
    await updateSrs(doc.id, () => null); doc.srs = null; doc.cards_paused = hasCards; if (hasCards) await library.update(doc.id, { cards_paused: true }); hideReviewBar(); renderSrs();
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
  $('#review-quiz').disabled = !aiConfig().key || !aiAllowed(); $('#review-quiz').title = aiConfig().key ? '' : 'Ajoute d\'abord ta clé API dans les réglages de l\'assistant';
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
  if (!aiAllowed()) return toast('L\'IA est désactivée pour ce cours.', false);
  if (!aiConfig().key) return openAiSettings();
  const session = ++quizSession;
  quiz = null; $('#quiz-title').textContent = `${T().quizTitle} · ${doc.name}`;
  if (!$('#quiz-dialog').open) $('#quiz-dialog').showModal();
  quizRender('loading');
  try {
    const text = await AI.ask(aiConfig(), { system: aiContext(), messages: [{ role: 'user', content: T().quizRequest(Date.now() % 1000) }] });
    if (session !== quizSession) return;
    const cards = AI.parseQuiz(text);
    if (!cards) throw new Error('L\'assistant n\'a pas renvoyé de questions exploitables. Réessaie.');
    quiz = { cards, i: 0, right: 0, revealed: false };
    quizRender('card');
  } catch (e) { if (session === quizSession) quizRender('error', e.message); }
}
function quizRender(state, msg = '') {
  const el = $('#quiz-body'), q = quiz;
  $('#quiz-count').textContent = state === 'card' ? `${T().item} ${q.i + 1} sur ${q.cards.length}` : '';
  if (state === 'loading') {
    el.innerHTML = `<span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><p class="quiz-note">${esc(T().loading)}</p>`;
  } else if (state === 'error') {
    el.innerHTML = `<p class="text-red-700" role="alert">${esc(msg)}</p><div class="quiz-actions"><button type="button" id="quiz-retry" class="tool tool-primary">Réessayer</button><button type="button" id="quiz-reread" class="tool">Relire le cours à la place</button></div>`;
    $('#quiz-retry').onclick = () => startQuiz(); $('#quiz-reread').onclick = startReread;
  } else if (state === 'card') {
    const c = q.cards[q.i];
    el.innerHTML = `<div class="quiz-progress"><i style="width:${(q.i / q.cards.length) * 100}%"></i></div><p class="quiz-q">${esc(c.q)}</p>` + (q.revealed
      ? `<div class="quiz-a ai-md">${mdToHtml(c.a)}</div><p class="quiz-note">${esc(T().knew)}</p>
         <div class="quiz-actions"><button type="button" class="tool" data-know="0">${esc(T().no)}</button><button type="button" class="tool tool-primary" data-know="1">${esc(T().yes)}</button></div>`
      : `<p class="quiz-note">${esc(T().ask)}</p><div class="quiz-actions"><button type="button" id="quiz-reveal" class="tool tool-primary">${esc(T().reveal)}</button></div>`);
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

/* ---------------------------------------------------------------- notes (notes du jour + feuille blanche) */
let notesTab = 'day', noteDay = '', noteTimer = null, freeTimer = null;
const noteLabel = t => (String(t).split('\n').map(l => l.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, '').trim()).find(Boolean)) || '';

function saveDayNote() {
  clearTimeout(noteTimer); noteTimer = null;
  const n = readNotes(), v = $('#note-text').value;
  if (v.trim()) n.days[noteDay] = v; else delete n.days[noteDay];
  $('#note-status').textContent = writeNotes(n) ? 'Enregistré' : '⚠️ Enregistrement impossible dans ce navigateur';
  renderNoteChips();
}
function saveFreeNote() {
  clearTimeout(freeTimer); freeTimer = null;
  const ok = lsSet(FREE_KEY, $('#free-text').value);
  $('#free-status').textContent = ok ? 'Enregistré' : '⚠️ Enregistrement impossible dans ce navigateur';
}
function flushNotes() { if (noteTimer) saveDayNote(); if (freeTimer) saveFreeNote(); }
addEventListener('pagehide', flushNotes);

function renderNoteChips() {
  const days = readNotes().days;
  const keys = Object.keys(days).filter(k => days[k].trim()).sort().reverse().slice(0, 30);
  $('#note-days').innerHTML = keys.length ? keys.map(k => `<li><button type="button" class="note-chip ${k === noteDay ? 'on' : ''}" data-nday="${k}">
      <b class="capitalize">${esc(fmtShort(k))}</b><small>${esc(noteLabel(days[k]) || '…')}</small></button></li>`).join('')
    : '<li class="text-sm text-slate-400">Aucune note pour le moment.</li>';
  $$('#note-days [data-nday]').forEach(b => b.onclick = () => gotoNoteDay(b.dataset.nday));
}
function gotoNoteDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  flushNotes();
  noteDay = day;
  $('#note-date').value = day;
  $('#note-title').textContent = day === todayIso() ? `aujourd'hui · ${fmtLong(day)}` : fmtLong(day);
  $('#note-text').value = readNotes().days[day] || '';
  $('#note-status').textContent = 'Enregistré';
  renderNoteChips();
}
const shiftDay = (day, n) => { const d = parseDay(day); d.setDate(d.getDate() + n); return iso(d); };
function setNotesTab(tab) {
  flushNotes(); notesTab = tab;
  $$('#notes-tabs [data-ntab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ntab === tab)));
  $('#notes-day').classList.toggle('hidden', tab !== 'day');
  $('#notes-free').classList.toggle('hidden', tab !== 'free');
}
const countWords = t => (t.trim() ? t.trim().split(/\s+/).length : 0);
function updateFreeCount() { const t = $('#free-text').value, w = countWords(t); $('#free-count').textContent = `${w} mot${w > 1 ? 's' : ''} · ${t.length} caractère${t.length > 1 ? 's' : ''}`; }

$$('#notes-tabs [data-ntab]').forEach(b => b.onclick = () => setNotesTab(b.dataset.ntab));
$('#note-prev').onclick = () => gotoNoteDay(shiftDay(noteDay, -1));
$('#note-next').onclick = () => gotoNoteDay(shiftDay(noteDay, 1));
$('#note-today').onclick = () => gotoNoteDay(todayIso());
$('#note-date').onchange = e => gotoNoteDay(e.target.value);
$('#note-text').oninput = () => { $('#note-status').textContent = 'Enregistrement…'; clearTimeout(noteTimer); noteTimer = setTimeout(saveDayNote, 400); };
$('#free-text').oninput = () => { updateFreeCount(); $('#free-status').textContent = 'Enregistrement…'; clearTimeout(freeTimer); freeTimer = setTimeout(saveFreeNote, 400); };
$('#note-addtask').onclick = () => {
  const t = $('#note-text'); t.value += (t.value && !t.value.endsWith('\n') ? '\n' : '') + '- [ ] ';
  t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.oninput();
};
$('#note-carry').onclick = () => {
  flushNotes();
  const days = readNotes().days, t = $('#note-text'), have = new Set(t.value.split('\n').map(l => l.trim()));
  const found = [];
  for (const k of Object.keys(days).filter(k => k < noteDay && k >= shiftDay(noteDay, -14)).sort().reverse()) {
    for (const l of days[k].split('\n')) if (/^\s*- \[ \]\s*\S/.test(l) && !have.has(l.trim()) && !found.includes(l.trim())) found.push(l.trim());
  }
  if (!found.length) return toast('Aucune tâche non finie à reprendre');
  t.value += (t.value && !t.value.endsWith('\n') ? '\n' : '') + found.join('\n') + '\n';
  t.oninput(); toast(`${plural(found.length, 'tâche reprise', 'tâches reprises')}`);
};
$('#free-download').onclick = () => download('feuille-blanche.txt', $('#free-text').value, 'text/plain;charset=utf-8');

async function loadNotes() {
  if (!noteDay) noteDay = todayIso();
  $('#free-text').value = readNotes().free; updateFreeCount();
  gotoNoteDay(noteDay);
  setNotesTab(notesTab);
}

/* ---------------------------------------------------------------- navigation */
async function refreshStatus() {
  const s = await api('/api/settings');
  $('#sync-status').textContent = s.last_sync ? `Sync : ${new Date(s.last_sync).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Pas encore synchronisé';
}
const loaders = { guide: loadGuide, dashboard: loadDashboard, calendar: loadCalendar, agenda: loadAgenda, subjects: loadSubjects, sync: loadSync,
                  notes: loadNotes, subject: loadSubject, doc: loadDoc };
function loadGuide() { window.scrollTo(0, 0); }
$$('[data-scroll]').forEach(b => b.onclick = () => document.getElementById(b.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
const NAV_OF = { subject: 'subjects', doc: 'subjects' };           // pages « enfants » : on garde « Matières » allumé
/* ---------------------------------------------------------------- créneau de révision au choix */
let extraStart = '';
async function loadExtraStarts() {
  const f = $('#extra-form'), box = $('#extra-starts'); extraStart = ''; $('#extra-save').disabled = true;
  if (!f.day.value) { box.innerHTML = ''; return; }
  const r = await api(`/api/free-slots?day=${f.day.value}&minutes=${f.minutes.value}`);
  box.innerHTML = r.starts.length ? r.starts.map(t => `<button type="button" class="tool" role="radio" aria-checked="false" data-start="${t}">${t}</button>`).join('')
    : '<p class="text-sm text-slate-500">Aucune plage libre assez longue ce jour-là : essaie un autre jour ou une durée plus courte.</p>';
  $$('[data-start]', box).forEach(b => b.onclick = () => {
    extraStart = b.dataset.start; $('#extra-save').disabled = false;
    $$('[data-start]', box).forEach(x => { const on = x === b; x.setAttribute('aria-checked', String(on)); x.classList.toggle('tool-primary', on); });
  });
}
$('#extra-open').onclick = guard(async () => {
  const f = $('#extra-form'), subs = await api('/api/subjects');
  if (!subs.length) return toast('Ajoute d\'abord ton emploi du temps : il n\'y a encore aucune matière.', false);
  f.subject.innerHTML = subs.map(x => `<option>${esc(x.name)}</option>`).join('');
  f.day.min = todayIso(); if (!f.day.value || f.day.value < f.day.min) f.day.value = todayIso();
  await loadExtraStarts(); $('#extra-dialog').showModal();
});
$('#extra-form').day.onchange = $('#extra-form').minutes.onchange = guard(loadExtraStarts);
$('#extra-form').onsubmit = guard(async e => {
  e.preventDefault(); const f = e.target;
  if (!extraStart) return;
  try { await api('/api/extras', { method: 'POST', json: { subject: f.subject.value, day: f.day.value, start: extraStart, minutes: Number(f.minutes.value) } }); }
  catch (err) { await loadExtraStarts(); throw err; }
  $('#extra-dialog').close(); toast(`Créneau ajouté : ${f.subject.value}, ${fmtShort(f.day.value)} à ${extraStart}`); await refresh();
});

const refresh = guard(async () => { await loaders[view](param); refreshStatus(); });
/* ---------------------------------------------------------------- fiches mémoire */
$$('[data-close]').forEach(b => b.onclick = () => $(`#${b.dataset.close}`).close());
const aiReady = () => !!aiConfig().key && aiAllowed();
const saveCards = async cards => { doc.cards = cards; await library.update(doc.id, { cards }); };

async function openDeck() {
  if (!doc) return;
  $('#deck-title').textContent = `Fiches · ${doc.name}`;
  $('#deck-gen').disabled = !aiReady(); $('#deck-gen').title = aiReady() ? '' : 'Ajoute d\'abord ta clé API dans les réglages de l\'assistant';
  renderDeck(); if (!$('#deck-dialog').open) $('#deck-dialog').showModal();
}
function renderDeck(msg = '') {
  const cards = cleanCards(doc.cards), today = todayIso(), due = cards.filter(c => c.srs.due <= today).length;
  $('#deck-count').textContent = plural(cards.length, 'fiche', 'fiches');
  $('#deck-study').disabled = !due; $('#deck-study').textContent = due ? `▶ Réviser (${due} à revoir)` : '▶ Rien à revoir aujourd\'hui';
  $('#deck-remind').checked = !doc.cards_paused; $('#deck-wipe').classList.toggle('hidden', !cards.length);
  $('#deck-msg').textContent = msg || (cards.length ? '' : 'Aucune fiche pour l\'instant : fais-les créer par l\'IA à partir du document, ou écris les tiennes.');
  $('#deck-list').innerHTML = cards.map(c => `<li><div class="min-w-0"><b>${esc(c.q)}</b><small>${esc(c.a)}</small><small>prochain rappel : ${esc(SRS.dueLabel(c.srs.due, today))}</small></div>
    <button type="button" data-delcard="${esc(c.id)}" title="Supprimer cette fiche">Supprimer</button></li>`).join('');
  $$('#deck-list [data-delcard]').forEach(b => b.onclick = guard(async () => { await saveCards(cleanCards(doc.cards).filter(c => c.id !== b.dataset.delcard)); renderDeck(); }));
}
$('#doc-cards').onclick = guard(openDeck);
$('#deck-remind').onchange = guard(async e => { doc.cards_paused = !e.target.checked; await library.update(doc.id, { cards_paused: doc.cards_paused }); renderDeck(e.target.checked ? 'Ces fiches reviendront dans tes rappels.' : 'Fiches en pause : elles n\'apparaîtront plus dans tes rappels.'); });
$('#deck-wipe').onclick = guard(async () => {
  const n = cleanCards(doc.cards).length;
  if (!confirm(`Supprimer définitivement les ${n} fiches de ce cours ?`)) return;
  await saveCards([]); renderDeck('Toutes les fiches ont été supprimées.');
});
$('#deck-form').onsubmit = guard(async e => {
  e.preventDefault();
  const r = addCards(doc.cards, [{ q: $('#deck-q').value, a: $('#deck-a').value }], todayIso());
  if (!r.added) return renderDeck('Cette question existe déjà dans les fiches.');
  await saveCards(r.cards); e.target.reset(); renderDeck('Fiche ajoutée.');
});
$('#deck-gen').onclick = guard(async () => {
  const btn = $('#deck-gen'); btn.disabled = true; renderDeck('L\'IA lit le document et écrit les fiches…');
  const d = doc;
  try {
    const known = cleanCards(d.cards).map(c => c.q);
    const text = await AI.ask(aiConfig(), { system: aiContext(), messages: [{ role: 'user', content: cardsRequest(10, known) }] });
    const fresh = parseCards(text);
    if (!fresh) throw new Error('L\'IA n\'a pas renvoyé de fiches exploitables : réessaie.');
    const r = addCards(d.cards, fresh, todayIso());
    await saveCards(r.cards); renderDeck(r.added ? `${plural(r.added, 'fiche créée', 'fiches créées')}. Elles sont à apprendre dès aujourd'hui.` : 'Ces fiches existaient déjà : relance pour en obtenir de nouvelles.');
  } catch (e) { renderDeck(e.message); } finally { btn.disabled = !aiReady(); }
});
$('#deck-study').onclick = () => { $('#deck-dialog').close(); startFlash(dueCards([{ id: doc.id, subject_name: doc.subject_name, name: doc.name, cards: doc.cards }], todayIso())); };

/* séance de fiches : question → réponse → note (oublié / difficile / bien / facile) */
let flash = null;
function startFlash(list) {
  if (!list.length) return toast('Aucune fiche à revoir');
  flash = { q: list.slice(0, 30), i: 0, done: 0, show: false, retried: new Set() };
  $('#flash-dialog').showModal(); flashRender();
}
function flashRender() {
  const f = flash, el = $('#flash-body'), today = todayIso();
  if (f.i >= f.q.length) {
    $('#flash-count').textContent = '';
    el.innerHTML = `<p class="quiz-score">🎉 ${plural(f.done, 'fiche revue', 'fiches revues')}</p><p>Les prochains rappels sont programmés : tu n'as rien d'autre à faire pour l'instant.</p>
      <div class="quiz-actions"><button type="button" class="tool tool-primary" data-close="flash-dialog" id="flash-end">Terminer</button></div>`;
    $('#flash-end').onclick = () => { $('#flash-dialog').close(); refresh(); }; return;
  }
  const it = f.q[f.i], c = it.card;
  $('#flash-count').textContent = `${f.i + 1} sur ${f.q.length}`;
  el.innerHTML = `<div class="quiz-progress"><i style="width:${(f.i / f.q.length) * 100}%"></i></div><p><span class="flash-chip">${esc(it.subject)}</span> <small class="text-slate-500">${esc(it.docName)}</small></p><p class="quiz-q">${esc(c.q)}</p>` + (f.show
    ? `<div class="quiz-a">${esc(c.a)}</div><div class="grade-row" id="flash-grades">${SRS.GRADES.map(g => `<button type="button" class="grade-btn" data-g="${g.id}"><b>${esc(g.label)}</b><small>${esc(SRS.intervalLabel(SRS.previewIntervals(c.srs, today)[g.id]))}</small></button>`).join('')}</div>`
    : `<p class="quiz-note">Réponds dans ta tête, puis vérifie.</p><div class="quiz-actions"><button type="button" id="flash-reveal" class="tool tool-primary">Voir la réponse</button></div>`);
  $('#flash-reveal')?.addEventListener('click', () => { f.show = true; flashRender(); });
  $$('#flash-grades [data-g]').forEach(b => b.onclick = guard(async () => {
    const g = b.dataset.g, rec = await library.get(it.docId);
    if (rec) { rec.cards = cleanCards(rec.cards).map(x => x.id === c.id ? gradeCard(x, g, today) : x); await library.update(it.docId, { cards: rec.cards }); if (doc && doc.id === it.docId) doc.cards = rec.cards; }
    if (g === 'again' && !f.retried.has(c.id)) { f.retried.add(c.id); f.q.push({ ...it, card: { ...c, srs: { ...c.srs, due: today } } }); }   // une fiche oubliée revient en fin de séance
    f.done++; f.i++; f.show = false; flashRender();
  }));
}
/** Fiches à revoir aujourd'hui : matières actives seulement, et pas les cours dont les rappels sont arrêtés. */
async function dueFlash() { const keep = await activeKeep(); return dueCards(await library.withCards(), todayIso(), r => !r.cards_paused && keep(r)); }
async function renderCardsCard() {
  const el = $('#cards-card'), due = await dueFlash();
  if (!due.length) { el.className = 'hidden'; el.innerHTML = ''; return; }
  const subs = [...new Set(due.map(d => d.subject))];
  el.className = 'cards-card';
  el.innerHTML = `<div class="min-w-0 flex-1"><h2 class="font-semibold">🃏 ${plural(due.length, 'fiche à revoir', 'fiches à revoir')}</h2>
    <p class="text-sm text-slate-500">${esc(subs.slice(0, 4).join(', '))}${subs.length > 4 ? '…' : ''} · ça prend ${Math.max(1, Math.round(Math.min(due.length, 30) * 0.4))} min</p></div>
    <button type="button" id="cards-go" class="rv-btn rv-btn-primary">Commencer</button>`;
  $('#cards-go').onclick = () => startFlash(due);
}

/* ---------------------------------------------------------------- rappel libre (révision active) + confiance */
$('#doc-recall').onclick = () => {
  if (!doc) return;
  $('#recall-title').textContent = `Rappel libre · ${doc.name}`;
  $('#recall-body').innerHTML = `<p>Sans regarder le document, <b>écris tout ce dont tu te souviens</b> : définitions, idées, formules, exemples. Même incomplet, c'est ce qui fait le plus progresser.</p>
    <textarea id="recall-text" class="recall-text" placeholder="Ce que je retiens…"></textarea>
    <div class="quiz-actions"><button type="button" id="recall-go" class="tool tool-primary">Comparer avec le cours</button></div>`;
  $('#recall-dialog').showModal(); $('#recall-text').focus();
  $('#recall-go').onclick = guard(recallCompare);
};
async function recallCompare() {
  const mine = $('#recall-text').value.trim();
  if (mine.length < 20) return toast('Écris un peu plus avant de comparer (quelques lignes).', false);
  const body = $('#recall-body'); let feedback = '';
  if (aiReady()) {
    body.innerHTML = '<span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><p class="quiz-note">L\'IA compare avec le cours…</p>';
    try { feedback = `<div class="quiz-a ai-md">${mdToHtml(await AI.ask(aiConfig(), { system: aiContext(), messages: [{ role: 'user', content: recallRequest(mine) }] }))}</div>`; }
    catch (e) { feedback = `<p class="text-red-700" role="alert">${esc(e.message)}</p>`; }
  } else if (doc.summary) feedback = `<p class="quiz-note">Compare avec le résumé du cours :</p><div class="quiz-a ai-md">${mdToHtml(doc.summary)}</div>`;
  else feedback = '<p class="quiz-note">Ferme cette fenêtre pour relire le cours, puis reviens noter ta confiance. (Avec une clé d\'assistant, l\'IA fait la comparaison pour toi.)</p>';
  body.innerHTML = `${feedback}<p class="mt-3"><b>Comment te sens-tu sur ce cours ?</b></p><div class="conf-row">${LEVELS.map(l => `<button type="button" data-lv="${l.v}">${l.icon} ${l.label}</button>`).join('')}</div>`;
  $$('#recall-body [data-lv]').forEach(b => b.onclick = guard(async () => { await rate(doc.subject_name, Number(b.dataset.lv)); $('#recall-dialog').close(); }));
}
async function rate(subject, level) {
  const r = await api('/api/confidence', { method: 'POST', json: { subject, level } });
  toast(r.level === 'weak' ? `Noté : « ${subject} » aura un peu plus de temps de révision` : 'Confiance enregistrée');
  if (view !== 'doc') await refresh();
}
let confTimer = null;
/** Après un créneau fait : « Comment te sens-tu ? » (barre discrète, disparaît seule). */
function askConfidence(subject, work) {
  const bar = $('#conf-bar'); clearTimeout(confTimer);
  bar.className = 'conf-bar';
  bar.innerHTML = `<span>Comment te sens-tu sur <b>${esc(subject)}</b> ?</span>${LEVELS.map(l => `<button type="button" data-lv="${l.v}" title="${l.label}">${l.icon} ${l.label}</button>`).join('')}<button type="button" id="conf-x" aria-label="Passer">✕</button>`;
  const hide = () => { clearTimeout(confTimer); bar.className = 'hidden'; bar.innerHTML = ''; };
  $$('#conf-bar [data-lv]').forEach(b => b.onclick = guard(async () => { hide(); await rate(subject, Number(b.dataset.lv)); await askLater(subject, work); }));
  $('#conf-x').onclick = hide; confTimer = setTimeout(hide, 20000);
}
/** Deuxième question après un créneau : « Te le rappeler plus tard ? » (seulement si un document est déposé et qu'aucun rappel n'est déjà lancé). */
async function askLater(subject, work) {
  const d = await pickDoc(subject, work);
  if (!d || d.srs) return;
  const bar = $('#conf-bar'); clearTimeout(confTimer);
  bar.className = 'conf-bar';
  bar.innerHTML = `<span>🔁 Te rappeler <b>${esc(d.name)}</b> plus tard, pour mieux le retenir ?</span><button type="button" id="later-yes">Oui, rappelle-moi</button><button type="button" id="later-no">Non merci</button>`;
  const hide = () => { clearTimeout(confTimer); bar.className = 'hidden'; bar.innerHTML = ''; };
  $('#later-no').onclick = hide;
  $('#later-yes').onclick = guard(async () => {
    const srs = await updateSrs(d.id, () => SRS.startCard(todayIso()));
    await library.update(d.id, { cards_paused: false });
    hide(); toast(`Rappel programmé : ${SRS.dueLabel(srs.due, todayIso())}. Tu peux l'arrêter depuis le cours.`); refresh();
  });
  confTimer = setTimeout(hide, 20000);
}
const confLine = s => {
  if (!s.confidence_n) return '';
  const icon = s.confidence_level === 'weak' ? '😕' : s.confidence_level === 'strong' ? '💪' : '🙂';
  const note = s.confidence_level === 'weak' ? ' · +25 % de temps de révision' : s.confidence_level === 'strong' ? ' · −15 % de temps, tu maîtrises' : '';
  return `<p class="conf-line ${s.confidence_level || ''}" title="Moyenne de tes dernières notes de confiance">${icon} Confiance : ${s.confidence.toFixed(1)}/3${note}</p>`;
};

/* ---------------------------------------------------------------- objectifs, défis et bilan */
const GOAL_KEY = 'campass-goal', GOALHIT_KEY = 'campass-goal-hit', FRIENDS_KEY = 'campass-friends', NAME_KEY = 'campass-myname';
const readGoal = () => Math.max(0, Math.min(3600, Number(lsGet(GOAL_KEY)) || 0));       // minutes par semaine
const readFriends = () => { try { const o = JSON.parse(lsGet(FRIENDS_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const hours = m => `${Math.round(m / 6) / 10} h`;

/** Carte « Mes statistiques » : chiffres, objectif, défis de la semaine, bilan et camarades. */
async function renderStats() {
  const card = $('#stats-card'), a = await api('/api/agenda'), subs = await api('/api/subjects'), today = todayIso(), log = readLog();
  const wk = weekByDay(log, today), rate = doneRate(a.sessions, today), st = streak(log, today), goal = readGoal();
  const active = subs.filter(s => s.enabled).map(s => s.name);
  card.classList.toggle('hidden', !active.length && !wk.total);
  $('#stats-sub').textContent = `${fmtDur(wk.total)} cette semaine · ${st} 🔥`;
  const max = Math.max(1, ...wk.subjects.map(x => x.minutes));
  const color = Object.fromEntries(subs.map(s => [s.name, s.color]));
  const late = a.sessions.filter(s => s.status === 'pending' && s.day < today).length;
  const ch = challenges(log, today, { goalMin: goal, subjects: active, lateCount: late });
  const recap = weekRecap(log, a.sessions, today, { goalMin: goal, subjects: active });
  const friends = Object.entries(readFriends());
  if (goal && wk.total >= goal && lsGet(GOALHIT_KEY) !== mondayOf(today)) { lsSet(GOALHIT_KEY, mondayOf(today)); toast('🎉 Objectif de la semaine atteint, bravo !'); }
  $('#stats-body').innerHTML = `<div class="stat-tiles">
      <div><b>${fmtDur(wk.total)}</b><small>révisées cette semaine</small></div>
      <div><b>${rate.pct === null ? '–' : rate.pct + ' %'}</b><small>créneaux faits (${rate.done}/${rate.due})</small></div>
      <div><b>${st} 🔥</b><small>${st > 1 ? 'jours d\'affilée' : 'jour d\'affilée'}</small></div></div>
    <ul class="stat-bars">${wk.subjects.map(x => `<li><span class="n">${esc(x.subject)}</span><span class="bar"><i style="width:${Math.round(100 * x.minutes / max)}%;background:${esc(color[x.subject] || '#64748b')}"></i></span><span class="v">${fmtDur(x.minutes)}</span></li>`).join('')}</ul>
    <h3 class="font-semibold text-sm mt-4">Défis de la semaine</h3>
    <div class="goal-row"><label for="goal-input">🎯 Mon objectif :</label><input id="goal-input" type="number" min="0" max="60" step="0.5" value="${goal ? goal / 60 : ''}" placeholder="0"> <span>h par semaine</span></div>
    ${ch.map(c => `<div class="chal ${c.done ? 'done' : ''}"><span>${c.done ? '✅' : c.icon}</span><b class="font-medium">${esc(c.label)}</b><small>${c.id === 'goal' ? `${hours(c.now)} / ${hours(c.target)}` : `${c.now} / ${c.target}`}</small>
      <span class="bar"><i style="width:${Math.round(100 * c.now / c.target)}%"></i></span></div>`).join('')}
    <details class="recap" ${new Date().getDay() === 0 ? 'open' : ''}><summary>📅 Bilan de la semaine${new Date().getDay() === 0 ? ' (c\'est dimanche !)' : ''}</summary>
      <pre>${esc(recapText(recap, hours, lsGet(NAME_KEY) || ''))}</pre>
      <button type="button" id="recap-share" class="tool">📤 Partager mon bilan</button></details>
    ${friends.length ? `<h3 class="font-semibold text-sm mt-4">👥 Camarades</h3>${friends.map(([n, f]) => `<div class="friend-row"><span>${esc(n)}</span><span>${hours(f.weekMin)} · ${f.streak} 🔥 <small class="text-slate-400">(${esc(fmtShort(f.d))})</small></span></div>`).join('')}
      <div class="friend-row"><b>Moi</b><span><b>${hours(wk.total)} · ${st} 🔥</b></span></div>` : ''}`;
  $('#goal-input').onchange = e => { const h = Math.max(0, Math.min(60, Number(e.target.value) || 0)); if (h) lsSet(GOAL_KEY, String(Math.round(h * 60))); else lsDel(GOAL_KEY); renderStats(); };
  $('#recap-share').onclick = guard(async () => shareText(recapText(recap, hours, lsGet(NAME_KEY) || '')));
}
async function shareText(text, url) {
  if (navigator.share) { try { await navigator.share({ text, ...(url ? { url } : {}) }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  await navigator.clipboard.writeText(url ? `${text}\n${url}` : text); toast('Copié : colle-le dans une conversation');
}

/* ---------------------------------------------------------------- repartir de zéro */
/** Décoche toutes les tâches `- [x]` des notes ; renvoie le nombre de tâches décochées. */
function uncheckTasks() {
  const n = readNotes(); let k = 0;
  for (const d of Object.keys(n.days)) n.days[d] = n.days[d].split('\n').map(l => { const m = l.match(TASK_RE); if (m && m[2] !== ' ') { k++; return `${m[1]}[ ] ${m[3]}`; } return l; }).join('\n');
  if (k) writeNotes(n);
  return k;
}
$('#rs-go').onclick = guard(async () => {
  const on = id => $(`#${id}`).checked, picked = ['rs-sessions', 'rs-tasks', 'rs-stats', 'rs-cards', 'rs-conf'].filter(on);
  if (!picked.length) return toast('Coche au moins une case.', false);
  if (!confirm('Repartir de zéro avec les éléments cochés ? Cette action est définitive' + (on('rs-backup') ? ' (une sauvegarde va d\'abord être téléchargée).' : ' et aucune sauvegarde ne sera faite.'))) return;
  if (on('rs-backup')) await exportBackup();
  const parts = [];
  if (on('rs-sessions') || on('rs-conf')) { await api('/api/restart', { method: 'POST', json: { sessions: on('rs-sessions'), confidence: on('rs-conf') } }); if (on('rs-sessions')) parts.push('créneaux'); if (on('rs-conf')) parts.push('confiance'); }
  if (on('rs-tasks')) { const k = uncheckTasks(); parts.push(plural(k, 'tâche décochée', 'tâches décochées')); }
  if (on('rs-stats')) { lsDel(STATS_KEY); lsDel(GOALHIT_KEY); parts.push('statistiques'); }
  if (on('rs-cards')) {
    const t = todayIso(); let k = 0;
    for (const r of await library.withCards()) { const cards = cleanCards(r.cards).map(c => ({ ...c, srs: { ...startCard(t), due: t } })); k += cards.length; await library.update(r.id, { cards }); }
    parts.push(plural(k, 'fiche remise à zéro', 'fiches remises à zéro'));
  }
  $('#rs-msg').textContent = `Remis à zéro : ${parts.join(', ')}.`;
  toast('Remise à zéro effectuée'); await refresh();
});

/* ---------------------------------------------------------------- partage avec un camarade */
$('#share-name').value = lsGet(NAME_KEY) || '';
$('#share-name').onchange = e => lsSet(NAME_KEY, e.target.value.trim().slice(0, 40));
async function buildMyShare() {
  const today = todayIso(), name = ($('#share-name').value || '').trim();
  const r = await api(`/api/courses-range?from=${addIsoDays(today, -7)}&to=${addIsoDays(today, 60)}`);
  if (!r.courses.length) throw new Error('Aucun cours à partager : importe d\'abord ton emploi du temps.');
  const log = readLog();
  return buildShare({ name, courses: r.courses, colors: r.colors, from: addIsoDays(today, -7), to: addIsoDays(today, 60), stats: { weekMin: weekByDay(log, today).total, streak: streak(log, today) } });
}
const addIsoDays = (d, n) => { const x = parseDay(d); x.setDate(x.getDate() + n); return iso(x); };
$('#share-link').onclick = guard(async () => {
  const code = await encodeShare(await buildMyShare()), url = `${location.origin}${location.pathname}#partage=${code}`;
  $('#share-note').textContent = url.length > 7000 ? `Lien long (${Math.round(url.length / 1000)} ko) : certaines messageries le coupent. Si ton camarade ne peut pas l'ouvrir, envoie plutôt le fichier.` : 'Lien prêt : seul qui le reçoit peut voir ton emploi du temps.';
  await shareText(`📚 Voici mon planning de cours sur Révisions Campass : ouvre le lien pour l'ajouter au tien.`, url);
});
$('#share-file').onclick = guard(async () => { download(`planning-${iso(new Date())}.json`, JSON.stringify(await buildMyShare())); toast('Fichier téléchargé : envoie-le à ton camarade'); });
$('#share-import').onchange = guard(async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  let raw; try { raw = JSON.parse(await readFile(f)); } catch { throw new Error('Ce fichier n\'est pas un planning partagé.'); }
  await showShare(parseShare(raw));
});
async function showShare(sh) {
  const mine = (await api('/api/courses-range?from=2000-01-01&to=2100-01-01')).courses, fresh = newCourses(sh.courses, mine, fold);
  const subjects = [...new Set(sh.courses.map(c => c.subject))], who = sh.name || 'Un camarade';
  const first = sh.courses.map(c => c.start.slice(0, 10)).sort()[0], last = sh.courses.map(c => c.start.slice(0, 10)).sort().pop();
  $('#share-title').textContent = `Planning de ${who}`;
  $('#share-body').innerHTML = `<p>👋 <b>${esc(who)}</b> te partage ${plural(sh.courses.length, 'cours', 'cours')} (${esc(fmtShort(first))} → ${esc(fmtShort(last))}) en ${esc(subjects.slice(0, 6).join(', '))}${subjects.length > 6 ? '…' : ''}.</p>
    <p>${fresh.length ? `<b>${plural(fresh.length, 'nouveau cours', 'nouveaux cours')}</b> à ajouter${fresh.length < sh.courses.length ? ` (${sh.courses.length - fresh.length} déjà dans ton planning)` : ''}.` : 'Tout est déjà dans ton planning.'}</p>
    ${sh.stats ? `<p class="text-sm text-slate-600">${esc(who)} a révisé ${hours(sh.stats.weekMin)} cette semaine, série de ${sh.stats.streak} jour${sh.stats.streak > 1 ? 's' : ''} 🔥 : tu pourras te comparer sur le tableau de bord.</p>` : ''}
    <div class="quiz-actions"><button type="button" class="tool" id="sh-no">Annuler</button><button type="button" class="tool tool-primary" id="sh-yes" ${fresh.length || sh.stats ? '' : 'disabled'}>Ajouter à mon planning</button></div>`;
  $('#share-dialog').showModal();
  $('#sh-no').onclick = () => $('#share-dialog').close();
  $('#sh-yes').onclick = guard(async () => {
    let msg = '';
    if (fresh.length) { const r = await api('/api/shared-courses', { method: 'POST', json: { courses: fresh, from_name: who } }); msg = `${plural(r.added, 'cours ajouté', 'cours ajoutés')} au planning`; }
    if (sh.stats && sh.name) { const fr = readFriends(); fr[sh.name] = { weekMin: sh.stats.weekMin, streak: sh.stats.streak, d: todayIso() }; lsSet(FRIENDS_KEY, JSON.stringify(fr)); msg = msg || 'Stats de ton camarade enregistrées'; }
    $('#share-dialog').close(); toast(msg); await refresh();
  });
}
async function openSharedFromHash(hash = location.hash) {
  const m = /^#partage=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return false;
  try { await showShare(parseShare(await decodeShare(m[1]))); } catch (e) { toast(e.message, false); }
  return true;
}

/* ---------------------------------------------------------------- installation, hors-ligne et rappels */
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderPhoneCard(); });
addEventListener('appinstalled', () => { installEvt = null; renderPhoneCard(); toast('Appli installée 🎉'); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function renderPhoneCard() {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => null) : null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), notif = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#pwa-install').classList.toggle('hidden', !installEvt);
  $('#notif-enable').classList.toggle('hidden', notif !== 'default');
  $('#pwa-status').innerHTML = [
    isStandalone() ? '✅ L\'appli est installée sur cet appareil.' : installEvt ? '📲 Prête à être installée : touche le bouton ci-dessus.'
      : ios ? '📲 Sur iPhone / iPad : touche le bouton Partager de Safari, puis « Sur l\'écran d\'accueil ».' : '📲 Dans le menu de ton navigateur, cherche « Installer l\'appli » ou « Ajouter à l\'écran d\'accueil ».',
    reg && reg.active ? '✅ Fonctionne sans connexion (hors-ligne).' : '⏳ Le mode hors-ligne s\'active après la première visite en ligne.',
    notif === 'granted' ? '🔔 Rappels activés (créneau qui commence, fin du minuteur).' : notif === 'denied' ? '🔕 Rappels bloqués dans les réglages du navigateur.' : notif === 'unsupported' ? 'Les rappels ne sont pas disponibles sur ce navigateur.' : '',
  ].filter(Boolean).map(t => `<li>${t}</li>`).join('');
}
$('#pwa-install').onclick = guard(async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderPhoneCard(); });
$('#notif-enable').onclick = guard(async () => { await Notification.requestPermission(); renderPhoneCard(); if (Notification.permission === 'granted') notify('Rappels activés', 'Tu seras prévenu quand un créneau commence.'); });
async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) return reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag }); } catch { /* repli ci-dessous */ }
  try { new Notification(title, { body, tag, icon: 'icons/icon-192.png' }); } catch { /* ignoré */ }
}
/** Tant que l'appli est ouverte (même en arrière-plan) : prévient 10 minutes avant un créneau. */
const notified = new Set();
async function startReminder() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const a = await api('/api/agenda').catch(() => null); if (!a) return;
  const now = new Date(), soon = a.sessions.filter(s => s.status === 'pending' && s.day === iso(now) && !notified.has(s.id)).filter(s => { const d = (new Date(s.start) - now) / 6e4; return d > 0 && d <= 10; });
  for (const s of soon) { notified.add(s.id); notify(`${(WORK[s.work] || WORK.review).icon} ${s.subject} dans 10 min`, sessionWhat(s), s.id); }
}
setInterval(startReminder, 60000);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').then(() => renderPhoneCard()).catch(() => {});
}

/* ---------------------------------------------------------------- refonte : apparence, accueil, sections repliables */
const THEME_KEY = 'campass-theme', FOLD_KEY = 'campass-fold', ONB_KEY = 'campass-onboard';
const THEMES = [['auto', '🌓 Auto'], ['light', '☀️ Clair'], ['dark', '🌙 Sombre']];
const themePref = () => { const t = lsGet(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; };
function applyTheme() {
  const p = themePref(), dark = p === 'dark' || (p === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#12161d' : '#1e293b');
  const b = $('#theme-btn'); if (b) b.textContent = THEMES.find(t => t[0] === p)[1];
}
$('#theme-btn').onclick = () => { const i = THEMES.findIndex(t => t[0] === themePref()); lsSet(THEME_KEY, THEMES[(i + 1) % 3][0]); applyTheme(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
applyTheme();

const readFolds = () => { try { return JSON.parse(lsGet(FOLD_KEY) || '{}') || {}; } catch { return {}; } };
/** Les <details> mémorisent leur état (ouvert / fermé) d'une visite à l'autre. */
function rememberFold(det, defaultOpen) {
  const f = readFolds(); det.open = det.id in f ? !!f[det.id] : defaultOpen;
  det.addEventListener('toggle', () => { const x = readFolds(); x[det.id] = det.open; lsSet(FOLD_KEY, JSON.stringify(x)); });
}
/** Transforme les cartes d'une page en sections repliables (les éléments sont déplacés, pas copiés : leurs boutons restent actifs). */
function foldify(root, order, openTitles) {
  const dets = [];
  [...root.children].forEach(card => {
    const h2 = card.classList.contains('bg-white') ? card.querySelector(':scope > h2') : null;
    if (!h2) return;
    const title = h2.textContent.trim(), det = document.createElement('details');
    det.className = 'fold'; det.id = 'fold-' + fold(title).replace(/\s+/g, '-').slice(0, 30);
    const sum = document.createElement('summary'); sum.append(h2); h2.className = 'font-semibold';
    card.classList.remove('bg-white', 'rounded-xl', 'border', 'border-slate-200', 'p-5'); card.classList.add('fold-body');
    card.replaceWith(det); det.append(sum, card); dets.push([title, det]);
  });
  const rank = t => { const i = order.findIndex(o => fold(t).includes(fold(o))); return i < 0 ? 99 : i; };
  dets.sort((a, b) => rank(a[0]) - rank(b[0])).forEach(([t, d]) => { root.append(d); rememberFold(d, openTitles.some(o => fold(t).includes(fold(o)))); });
}
foldify($('#view-sync'), ['Importer', 'Sauvegarde', 'Partager', 'Sur ton téléphone', 'calendrier', 'bloqués', 'cours ajoutés', 'Repartir'], ['Importer', 'Sauvegarde']);
['#priority-card', '#stats-card'].forEach(sel => rememberFold($(sel), sel === '#stats-card'));

/** En-tête du tableau de bord : salutation, résumé de la journée, bouton « Commencer ». */
async function renderHero(t) {
  const el = $('#hero'), h = new Date().getHours(), hello = h < 5 || h >= 18 ? 'Bonsoir' : h < 12 ? 'Bonjour' : 'Bon après-midi';
  const text = readNotes().days[todayIso()] || '', tasks = text.split('\n').filter(l => { const m = l.match(TASK_RE); return m && m[2] === ' ' && m[3].trim(); }).length;
  const cards = (await dueFlash()).length;
  const todo = t.todo.filter(s => s.status === 'pending').sort((a, b) => a.start.localeCompare(b.start)), minutes = todo.reduce((n, s) => n + s.minutes, 0);
  const bits = [todo.length && `${plural(todo.length, 'créneau', 'créneaux')} (${fmtDur(minutes)})`, tasks && plural(tasks, 'tâche', 'tâches'), cards && plural(cards, 'fiche', 'fiches')].filter(Boolean);
  const timer = readTimer(), next = t.upcoming[0];
  el.innerHTML = `<div class="min-w-0"><p class="hero-date">${esc(fmtLong(t.date))}</p><h1 class="hero-title">${hello} 👋</h1>
    <p class="hero-sum">${bits.length ? `Aujourd'hui : <b>${esc(bits.join(' · '))}</b>` : `Rien de prévu aujourd'hui 🎉${next ? ` Prochaine révision : ${esc(next.subject)}, ${esc(fmtShort(next.day))}.` : ''}`}</p></div>
    ${timer && timer.end > Date.now() ? `<span class="hero-run">⏱ En cours : ${esc(timer.subject)}</span>` : todo.length ? `<button type="button" id="hero-go" class="hero-go">▶ Commencer · ${esc(todo[0].subject)}</button>` : ''}`;
  $('#hero-go')?.addEventListener('click', () => { index(todo); startTimer(todo[0]); toast(`Minuteur lancé : ${todo[0].subject} (${fmtDur(todo[0].minutes)})`); renderHero(t); });
}

/** Premier usage : trois étapes pour démarrer. */
function renderOnboarding(subjectsCount) {
  const el = $('#onboard-card'), st = (() => { try { return JSON.parse(lsGet(ONB_KEY) || '{}') || {}; } catch { return {}; } })();
  const steps = [
    { done: subjectsCount > 0, view: 'sync', t: 'Importe ton emploi du temps', d: 'Un fichier .ics exporté de Campass (ou un lien d\'abonnement).' },
    { done: !!st.subjects, view: 'subjects', t: 'Règle tes matières', d: 'Durée des sessions, nombre de chapitres, intensité.' },
    { done: Object.keys(readLog()).length > 0, view: 'agenda', t: 'Fais ton premier créneau', d: 'Ouvre l\'agenda, lance le minuteur, puis marque-le « Fait ».' },
  ];
  if (st.hide || steps.every(s => s.done)) { el.className = 'hidden'; el.innerHTML = ''; return; }
  el.className = 'onboard';
  el.innerHTML = `<div class="flex items-baseline gap-2"><h2 class="font-semibold">🚀 Pour bien démarrer</h2><span class="text-xs text-slate-500">${steps.filter(s => s.done).length} / 3</span>
      <button type="button" id="onb-guide" class="ml-auto text-xs text-blue-600 hover:underline">📖 Lire le guide</button><button type="button" id="onb-hide" class="text-xs text-slate-500 hover:underline">Masquer</button></div>
    <ol class="onb-steps">${steps.map((s, i) => `<li class="${s.done ? 'done' : ''}"><span class="onb-n">${s.done ? '✓' : i + 1}</span><div class="min-w-0 flex-1"><b>${s.t}</b><small>${s.d}</small></div>
      ${s.done ? '' : `<button type="button" class="rv-btn" data-go="${s.view}">Ouvrir</button>`}</li>`).join('')}</ol>`;
  $$('#onboard-card [data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
  $('#onb-guide').onclick = () => show('guide');
  $('#onb-hide').onclick = () => { lsSet(ONB_KEY, JSON.stringify({ ...st, hide: true })); renderOnboarding(subjectsCount); };
}

renderTimer();
function show(v, p = null) {
  flushNotes();
  if (full.on && v !== 'doc') setFull(false);
  view = loaders[v] ? v : 'dashboard';
  if (view === 'subjects') { try { const o = JSON.parse(lsGet(ONB_KEY) || '{}') || {}; if (!o.subjects) lsSet(ONB_KEY, JSON.stringify({ ...o, subjects: true })); } catch { /* sans effet */ } }
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
  const shared = /^#partage=/.test(location.hash) ? location.hash : '';
  const [v, ...rest] = (shared ? '#dashboard' : location.hash).slice(1).split('/');
  let p = null; try { p = decodeURIComponent(rest.join('/')); } catch { /* hash invalide */ }
  show(v || 'dashboard', p);
  if (shared) await openSharedFromHash(shared);
  renderPhoneCard();
}
