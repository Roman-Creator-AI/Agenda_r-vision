// Fiches mémoire, confiance, défis, partage entre camarades et routes associées du backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard, addCards, dueCards, gradeCard, cleanCards, parseCards, cardsRequest } from '../docs/js/cards.js';
import { addRating, summary, intensityFactor, cleanConfidence } from '../docs/js/confidence.js';
import { challenges, weekRecap, recapText, cleanLog } from '../docs/js/stats.js';
import { buildShare, parseShare, newCourses, encodeShare, decodeShare } from '../docs/js/share.js';
import { createBackend, ApiError } from '../docs/js/backend.js';
import { Store } from '../docs/js/store.js';
import { fold } from '../docs/js/library.js';

const T = '2026-11-14';

test('fiches : sans doublon, à apprendre dès aujourd\'hui, rappel qui s\'espace', () => {
  const r = addCards([], [{ q: 'Dérivée de x² ?', a: '2x' }, { q: 'DÉRIVÉE de x² ?', a: 'doublon' }, { q: '', a: 'x' }], T);
  assert.equal(r.added, 1);
  assert.equal(r.cards[0].srs.due, T);
  const g = gradeCard(r.cards[0], 'good', T);
  assert.ok(g.srs.due > T && g.q === r.cards[0].q);
  const forgot = gradeCard(r.cards[0], 'again', T);
  assert.equal(forgot.srs.due, '2026-11-15');
  const recs = [{ id: 1, subject_name: 'Maths', name: 'Cours 1', cards: [g, makeCard({ q: 'a', a: 'b' }, T)] }, { id: 2, subject_name: 'SIP', name: 'x', cards: [] }];
  assert.equal(dueCards(recs, T).length, 1);
  assert.equal(dueCards(recs, T, r => r.id !== 1).length, 0);
  assert.equal(cleanCards([{ q: 'a', a: 'b' }, null, { q: 'a', a: 'b', srs: { due: 'x' } }]).length, 0);       // fiches invalides écartées
});

test('fiches IA : lecture tolérante du JSON, demande sans répéter les questions connues', () => {
  assert.equal(parseCards('Voici :\n```json\n[{"q":"A ?","a":"B"},{"q":"C ?","a":"D"}]\n```').length, 2);
  assert.equal(parseCards('pas de json'), null);
  assert.equal(parseCards('[{"q":"1","a":"2"}]').length, 1);                                                // une seule fiche suffit (différent du quiz)
  assert.match(cardsRequest(10, ['Déjà là ?']), /Déjà là \?/);
});

test('confiance : fragile → +25 % de temps, solide → −15 %, pas assez de notes → neutre', () => {
  let l = addRating([], 1, '2026-11-10');
  assert.equal(summary(l).level, null); assert.equal(intensityFactor(l), 1);
  l = addRating(l, 2, '2026-11-11'); assert.equal(summary(l).level, 'weak'); assert.equal(intensityFactor(l), 1.25);
  const s = [3, 3, 3].reduce((a, c, i) => addRating(a, c, `2026-11-0${i + 1}`), []);
  assert.equal(intensityFactor(s), 0.85);
  assert.equal(addRating(Array(20).fill({ d: T, c: 2 }), 3, T).length, 8);                                    // historique borné
  assert.deepEqual(cleanConfidence({ Maths: [{ d: T, c: 9 }, { d: T, c: 2 }], '': [{ d: T, c: 1 }] }), { Maths: [{ d: T, c: 2 }] });
});

test('défis de la semaine et bilan', () => {
  const log = cleanLog({ a: { d: '2026-11-09', subject: 'Maths', minutes: 60 }, b: { d: '2026-11-10', subject: 'SIP', minutes: 60 },
    c: { d: '2026-11-12', subject: 'Maths', minutes: 60 }, d: { d: '2026-11-13', subject: 'Maths', minutes: 60 } });
  const ch = Object.fromEntries(challenges(log, T, { goalMin: 240, subjects: ['Maths', 'SIP', 'Chimie'], lateCount: 0 }).map(c => [c.id, c]));
  assert.ok(ch.goal.done && ch.days.done && ch.late.done);
  assert.equal(ch.all.now, 2); assert.ok(!ch.all.done);                                                       // Chimie oubliée
  assert.equal(challenges(log, T, {}).some(c => c.id === 'goal'), false);                                     // pas d'objectif : pas de défi d'heures
  const r = weekRecap(log, [{ status: 'done', day: '2026-11-10' }, { status: 'pending', day: '2026-11-13' }], T, { goalMin: 480, subjects: ['Maths', 'SIP', 'Chimie'] });
  assert.equal(r.pct, 50); assert.deepEqual(r.neglected, ['Chimie']); assert.equal(r.best.subject, 'Maths');
  const txt = recapText(r, m => `${m} min`, 'Léa');
  assert.match(txt, /Léa/); assert.match(txt, /Chimie/); assert.match(txt, /50 %/);
});

const courses = [
  { subject: 'Maths', kind: 'CM', start: '2026-11-16T09:00', end: '2026-11-16T11:00', room: 'A1' },
  { subject: 'SIP', kind: 'TD', start: '2026-11-17T14:00', end: '2026-11-17T16:00', room: '' },
  { subject: 'Vieux', kind: 'CM', start: '2026-09-01T09:00', end: '2026-09-01T11:00', room: '' },
];
test('partage : aller-retour dans un lien, période limitée, validation stricte', async () => {
  const sh = buildShare({ name: 'Léa', courses, colors: { Maths: '#112233' }, stats: { weekMin: 125.4, streak: 3 }, from: '2026-11-07', to: '2027-01-13' });
  assert.equal(sh.courses.length, 2);                                                                         // le vieux cours est exclu
  const code = await encodeShare(sh);
  assert.match(code, /^[zj][A-Za-z0-9_-]+$/);                                                                 // utilisable tel quel dans une URL
  const back = parseShare(await decodeShare(code));
  assert.equal(back.name, 'Léa'); assert.equal(back.courses[0].subject, 'Maths'); assert.deepEqual(back.stats, { weekMin: 125, streak: 3 });
  await assert.rejects(decodeShare('zzzz'), /abîmé|incomplet/);
  assert.throws(() => parseShare({ app: 'autre', v: 1 }), /pas un planning/);
  assert.throws(() => parseShare({ app: 'campass-partage', v: 1, courses: [['x', '', 'pas une date', '2026-11-16T10:00', '']] }), /aucun cours/);
  const evil = parseShare({ app: 'campass-partage', v: 1, name: '<b>x</b>'.repeat(30), courses: [['A', 'CM', '2026-11-16T09:00', '2026-11-16T10:00', '']], colors: { A: 'javascript:1' } });
  assert.ok(evil.name.length <= 40); assert.deepEqual(evil.colors, {});
  assert.equal(newCourses(back.courses, [{ subject: 'maths', start: '2026-11-16T09:00', end: '2026-11-16T11:00' }], fold).length, 1);
});

async function setup() {
  const m = new Map(), storage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
  const store = new Store(storage);
  const api = await createBackend({ store, today: () => T, now: () => new Date(`${T}T12:00:00`) });
  return { api, call: (me, p, b) => api.handle(me, p, b), store, storage };
}
test('backend : cours d\'un camarade ajoutés sans doublon, retirables ; sauvegarde conserve tout', async () => {
  const { call, store, storage } = await setup();
  const mine = { courses: courses.slice(0, 1).map(c => ({ ...c })), from_name: 'Léa' };
  const r1 = await call('POST', '/api/shared-courses', mine);
  assert.equal(r1.added, 1);
  const r2 = await call('POST', '/api/shared-courses', { courses, from_name: 'Léa' });                        // Maths déjà là
  assert.equal(r2.added, 2);
  assert.equal((await call('GET', '/api/courses-range?from=2026-11-01&to=2026-12-01')).courses.length, 2);
  assert.equal((await call('GET', '/api/subjects')).length, 3);                                              // les matières apparaissent
  await call('POST', '/api/shared-courses', { courses: [{ subject: 'X', start: 'nimporte', end: 'quoi' }], from_name: 'Léa' });
  assert.equal((await call('GET', '/api/custom-courses')).length, 3);
  const del = await call('DELETE', '/api/shared-courses/L%C3%A9a');
  assert.equal(del.removed, 3);
  assert.equal((await call('GET', '/api/custom-courses')).length, 0);
});
test('backend : la confiance d\'une matière fragile augmente son temps de révision', async () => {
  const { call } = await setup();
  const ics = d => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:m@x\r\nSUMMARY:Maths CM\r\nDTSTART:${d}T100000\r\nDTEND:${d}T120000\r\nRRULE:FREQ=WEEKLY;COUNT=6\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  await call('POST', '/api/upload', { text: ics('20261112') });
  const total = async () => (await call('GET', '/api/agenda')).sessions.filter(s => s.status !== 'missed').reduce((n, s) => n + s.minutes, 0);
  const before = await total();
  await assert.rejects(call('POST', '/api/confidence', { subject: 'Maths', level: 7 }), e => e instanceof ApiError && e.status === 400);
  await assert.rejects(call('POST', '/api/confidence', { subject: 'Inconnue', level: 1 }), e => e.status === 404);
  await call('POST', '/api/confidence', { subject: 'Maths', level: 1 });
  assert.equal(await total(), before);                                                                        // une seule note : pas de changement
  const r = await call('POST', '/api/confidence', { subject: 'maths', level: 1 });
  assert.equal(r.level, 'weak');
  assert.ok(await total() > before, 'matière fragile : plus de minutes');
  const s = (await call('GET', '/api/subjects'))[0];
  assert.equal(s.confidence_level, 'weak'); assert.equal(s.confidence_n, 2);
  const saved = JSON.parse((await call('GET', '/api/export')).text).data;                                    // la confiance voyage dans la sauvegarde
  assert.equal(saved.confidence.Maths.length, 2);
});
