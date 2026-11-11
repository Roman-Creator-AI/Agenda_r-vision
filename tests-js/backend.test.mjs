// Parcours complets du « backend » navigateur (mêmes scénarios que tests/test_app.py côté Python).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, ApiError } from '../docs/js/backend.js';
import { Store, KEY, emptyState } from '../docs/js/store.js';
import { addDays } from '../docs/js/dates.js';

const TODAY = '2026-11-10';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

async function setup({ fetchFn, storage = fakeStorage(), nowIso = '2026-11-10T12:00:00' } = {}) {
  const store = new Store(storage);
  const api = await createBackend({ store, today: () => TODAY, now: () => new Date(nowIso), fetchFn });
  const call = (method, path, body) => api.handle(method, path, body);
  return { store, api, storage, call };
}

const ics = (pastDays = 9) => {
  const start = addDays(TODAY, -pastDays).replaceAll('-', '') + 'T100000';
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:m@x\r\n` +
    `SUMMARY:Maths - FR - CM - S1\r\nDTSTART:${start}\r\nDTEND:${start.slice(0, 9)}120000\r\n` +
    `RRULE:FREQ=WEEKLY;COUNT=10\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
};
const agenda = async call => (await call('GET', '/api/agenda')).sessions;
const backlog = async call => (await call('GET', '/api/subjects'))[0].backlog;
const rejects = (p, status) => assert.rejects(p, e => e instanceof ApiError && e.status === status);

test('import ICS : cours, matières, couleur stable et statut de synchronisation', async () => {
  const { call } = await setup();
  assert.deepEqual(await call('POST', '/api/upload', { text: ics() }), { count: 10, subjects: 1 });
  const [maths] = await call('GET', '/api/subjects');
  assert.equal(maths.name, 'Maths');
  assert.match(maths.color, /^#[0-9a-f]{6}$/);
  const s = await call('GET', '/api/settings');
  assert.equal(s.last_sync_count, '10');
  assert.equal(s.last_sync, '2026-11-10T12:00:00');
  await rejects(call('POST', '/api/upload', { text: 'n\'importe quoi' }), 400);
});

test('la couleur d\'une matière est la même qu\'en Python (sha1 mod 12)', async () => {
  const { colorFor } = await import('../docs/js/backend.js');
  const { sha1Hex } = await import('../docs/js/sha1.js');
  // valeur de référence calculée avec db.color_for('Maths') côté Python
  assert.equal(colorFor('Maths', sha1Hex), '#16a34a');
});

test('« Non fait » : +1 de retard, rattrapage futur, remboursement par « Fait », annulation', async () => {
  const { call } = await setup();
  await call('POST', '/api/upload', { text: ics() });
  const past = (await agenda(call)).find(s => s.day === addDays(TODAY, -3) && !s.catchup);
  assert.ok(past && past.status === 'pending' && past.overdue);

  const r = await call('PATCH', `/api/sessions/${past.id}`, { status: 'missed' });
  assert.equal(r.backlog, 1);
  assert.equal(await backlog(call), 1);
  const catchups = (await agenda(call)).filter(s => s.catchup);
  assert.equal(catchups.length, 1);
  assert.ok(catchups[0].day > TODAY, 'jamais aujourd\'hui');
  assert.ok(!(await call('GET', '/api/today')).todo.some(s => s.id === past.id));

  await call('PATCH', `/api/sessions/${past.id}`, { status: 'missed' });            // idempotent
  assert.equal(await backlog(call), 1);

  assert.equal((await call('PATCH', `/api/sessions/${catchups[0].id}`, { status: 'done' })).backlog, 0);
  assert.deepEqual((await agenda(call)).filter(s => s.catchup).map(s => s.status), ['done']);

  await call('PATCH', `/api/sessions/${past.id}`, { status: 'pending' });           // annule le « Non fait »
  assert.equal((await agenda(call)).find(s => s.id === past.id).status, 'pending');
});

test('dette saisie à la main : rattrapages plafonnés par cycle, validations', async () => {
  const { call } = await setup();
  await call('POST', '/api/upload', { text: ics() });
  await call('PUT', '/api/subjects', { name: 'Maths', backlog: 3 });
  const perCycle = {};
  for (const s of (await agenda(call)).filter(x => x.catchup)) perCycle[s.target.slice(0, 10)] = (perCycle[s.target.slice(0, 10)] || 0) + 1;
  assert.deepEqual(Object.values(perCycle).sort().reverse(), [2, 1]);
  await rejects(call('PUT', '/api/subjects', { name: 'Maths', backlog: -1 }), 400);
  await rejects(call('PUT', '/api/subjects', { name: 'Maths', backlog: 'abc' }), 400);
  await rejects(call('PUT', '/api/subjects', { name: 'Maths', color: 'rouge' }), 400);
  await rejects(call('PUT', '/api/subjects', { name: 'Inconnue', backlog: 1 }), 404);
  await call('PUT', '/api/subjects', { name: 'maths', backlog: '0' });              // insensible à la casse
  assert.equal((await agenda(call)).filter(s => s.catchup).length, 0);
});

test('la charge se recalcule quand on change les réglages d\'une matière', async () => {
  const { call } = await setup();
  await call('POST', '/api/upload', { text: ics() });
  const before = (await call('GET', '/api/subjects'))[0];
  await call('PUT', '/api/subjects', { name: 'Maths', chapters: 6, intensity: 1.5 });
  const after = (await call('GET', '/api/subjects'))[0];
  assert.deepEqual([before.slots, after.slots, after.slot_minutes], [1, 3, 90]);
});

test('déplacement, réinitialisation et blocages', async () => {
  const { call } = await setup();
  await call('POST', '/api/upload', { text: ics() });
  const s = (await agenda(call)).find(x => x.day > TODAY && !x.catchup);
  const target = addDays(s.day, 0);
  await call('PATCH', `/api/sessions/${s.id}`, { day: target, start: '14:30' });
  let moved = (await agenda(call)).find(x => x.id === s.id);
  assert.equal(moved.start.slice(11), '14:30'); assert.ok(moved.moved);
  await call('PATCH', `/api/sessions/${s.id}`, { reset: true });
  assert.ok(!(await agenda(call)).find(x => x.id === s.id).moved);
  await rejects(call('PATCH', `/api/sessions/${s.id}`, { day: 'hier', start: '14:30' }), 400);
  await rejects(call('PATCH', '/api/sessions/abcdef012345', { status: 'done' }), 404);

  await call('POST', '/api/blocks', { day: s.day, start: '18:00', end: '21:00', label: 'Sport' });
  const placed = (await agenda(call)).find(x => x.id === s.id);
  assert.ok(placed.overloaded || !(placed.start.slice(11) < '21:00' && placed.end.slice(11) > '18:00'), 'évite le blocage 18h-21h');
  await rejects(call('POST', '/api/blocks', { day: s.day, start: '18:00', end: '17:00' }), 400);
  const [b] = await call('GET', '/api/blocks');
  await call('DELETE', `/api/blocks/${b.id}`);
  assert.deepEqual(await call('GET', '/api/blocks'), []);
});

test('vues semaine et jour : forme identique à l\'API Flask', async () => {
  const { call } = await setup();
  await call('POST', '/api/upload', { text: ics() });
  const w = await call('GET', `/api/week?start=${TODAY}`);
  assert.equal(w.start, '2026-11-09');                                  // ramené au lundi
  assert.deepEqual(Object.keys(w).sort(), ['blocks', 'courses', 'day_end', 'day_start', 'load', 'sessions', 'start']);
  assert.ok(w.courses.every(c => c.color && c.start < '2026-11-16' && c.end > '2026-11-09'));
  const t = await call('GET', '/api/today');
  assert.deepEqual(Object.keys(t).sort(), ['date', 'load', 'todo', 'upcoming']);
  assert.ok(t.todo.every(s => s.day === TODAY || (s.day < TODAY && s.status === 'pending')));
});

test('persistance : les données survivent à un rechargement de la page', async () => {
  const storage = fakeStorage();
  const a = await setup({ storage });
  await a.call('POST', '/api/upload', { text: ics() });
  await a.call('PUT', '/api/subjects', { name: 'Maths', backlog: 2 });
  assert.ok(storage._m.has(KEY));
  const b = await setup({ storage });                                    // « nouvelle page »
  assert.equal(await backlog(b.call), 2);
  assert.equal((await b.call('GET', '/api/settings')).last_sync_count, '10');
});

test('sauvegarde / restauration : aller-retour, fichier invalide, données nettoyées', async () => {
  const a = await setup();
  await a.call('POST', '/api/upload', { text: ics() });
  await a.call('PUT', '/api/subjects', { name: 'Maths', backlog: 2 });
  const { text } = await a.call('GET', '/api/export');

  const b = await setup();
  await b.call('POST', '/api/import', { text });
  assert.equal(await backlog(b.call), 2);
  assert.deepEqual((await agenda(b.call)).map(s => s.id), (await agenda(a.call)).map(s => s.id));

  await rejects(b.call('POST', '/api/import', { text: '{pas du json' }), 400);
  await rejects(b.call('POST', '/api/import', { text: JSON.stringify({ app: 'autre', data: {} }) }), 400);

  const hostile = JSON.stringify({ app: 'campass-revisions', data: {
    ...emptyState(), subjects: { '<img src=x onerror=alert(1)>': { color: 'red;background:url(x)', backlog: 9999, session_minutes: 'x' } },
    courses: [{ subject: 's', start: 'pas une date', end: 'x' }], states: { 'pas-un-sid': { status: 'done' } } } });
  await b.call('POST', '/api/import', { text: hostile });
  const [subject] = await b.call('GET', '/api/subjects');
  assert.equal(subject.color, '#64748b');                               // couleur invalide remplacée
  assert.equal(subject.backlog, 99);                                    // borné
  assert.equal(subject.session_minutes, 60);                            // valeur invalide -> défaut
  assert.equal((await b.call('GET', '/api/week')).courses.length, 0);   // cours mal formé écarté
});

test('lien ICS : synchro par URL, blocage CORS mémorisé, rafraîchissement automatique', async () => {
  let calls = 0, fail = false;
  const fetchFn = async () => { calls++; if (fail) throw new TypeError('Failed to fetch'); return { ok: true, text: async () => ics() }; };
  const { call, api, store } = await setup({ fetchFn });

  await rejects(call('POST', '/api/sync', {}), 400);                           // aucun lien
  await rejects(call('PUT', '/api/settings', { ics_url: 'ftp://x' }), 400);
  assert.equal((await call('POST', '/api/sync', { url: 'webcal://geode.example/secret-token' })).count, 10);
  const s = await call('GET', '/api/settings');
  assert.ok(s.ics_configured && s.ics_url_masked === '…-token' && !JSON.stringify(s).includes('geode.example'));

  assert.equal(await api.autoSync(), null);                                    // synchro récente : rien à faire
  assert.equal(calls, 1);
  store.state.settings.last_sync = '2026-11-10T09:00:00';                      // 3 h plus tôt
  assert.equal((await api.autoSync()).count, 10);
  assert.equal(calls, 2);

  fail = true;
  store.state.settings.last_sync = '2026-11-09T09:00:00';
  assert.equal(await api.autoSync(), null);                                    // échec silencieux...
  assert.match((await call('GET', '/api/settings')).last_error, /CORS/);       // ...mais mémorisé
  await rejects(call('POST', '/api/sync', {}), 502);
});

test('stockage indisponible (navigation privée) : l\'appli fonctionne, sans persistance', async () => {
  const store = new Store(null);
  const api = await createBackend({ store, today: () => TODAY, now: () => new Date('2026-11-10T12:00:00') });
  await api.handle('POST', '/api/upload', { text: ics() });
  assert.equal((await api.handle('GET', '/api/settings')).persistent, false);
  assert.equal((await api.handle('GET', '/api/subjects')).length, 1);
});

test('remise à zéro', async () => {
  const { call, storage } = await setup();
  await call('POST', '/api/upload', { text: ics() });
  await call('POST', '/api/reset');
  assert.equal((await call('GET', '/api/subjects')).length, 0);
  assert.ok(!storage._m.has(KEY));
});
