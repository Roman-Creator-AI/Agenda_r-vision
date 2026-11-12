// Rappels de mémorisation : répétition espacée (SM-2 simplifié), placement dans le calendrier, quiz de l'IA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SRS from '../docs/js/srs.js';
import { parseQuiz, quizRequest } from '../docs/js/ai.js';
import { openLibrary } from '../docs/js/library.js';

const D = '2026-11-12';                                              // un jeudi

test('dates : calcul en jours calendaires, insensible au changement d\'heure', () => {
  assert.equal(SRS.addDays('2026-10-24', 2), '2026-10-26');           // passage à l'heure d'hiver le 25/10
  assert.equal(SRS.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(SRS.daysBetween('2026-10-24', '2026-10-26'), 2);
});

test('nouveau cycle : premier rappel le lendemain du jour travaillé, même dans le passé', () => {
  assert.equal(SRS.startCard(D).due, '2026-11-13');
  assert.equal(SRS.startCard('2026-11-09').due, '2026-11-10');        // travaillé lundi : déjà dû
  assert.ok(SRS.isDue(SRS.startCard('2026-11-09'), D));
  assert.ok(!SRS.isDue(SRS.startCard(D), D));
});

test('« Bien » à répétition : 3 jours, 7 jours, puis ×facilité', () => {
  let c = SRS.startCard(D), day = SRS.addDays(D, 1);
  const seen = [];
  for (let i = 0; i < 5; i++) { c = SRS.review(c, 'good', day); seen.push(c.interval); day = c.due; }
  assert.deepEqual(seen.slice(0, 3), [3, 7, 18]);                     // 7 × 2,5 = 17,5 → 18
  assert.ok(seen[3] > seen[2] && seen[4] > seen[3]);
});

test('« Oublié » ramène à demain et baisse la facilité (jamais sous 1,3) ; « Difficile » avance peu', () => {
  let c = { ...SRS.startCard(D), interval: 20, reps: 4, ease: 2.5 };
  const forgot = SRS.review(c, 'again', D);
  assert.equal(forgot.interval, 1); assert.equal(forgot.due, '2026-11-13'); assert.equal(forgot.reps, 0);
  assert.equal(forgot.lapses, 1); assert.equal(forgot.ease, 2.3);
  let low = { ...c, ease: 1.35 };
  assert.equal(SRS.review(low, 'again', D).ease, 1.3);
  const hard = SRS.review(c, 'hard', D);
  assert.equal(hard.interval, 24); assert.equal(hard.ease, 2.35);
  const easy = SRS.review(c, 'easy', D);
  assert.ok(easy.interval > SRS.review(c, 'good', D).interval && easy.ease > 2.5);
});

test('l\'intervalle est plafonné, la carte d\'origine n\'est pas modifiée, l\'historique est borné', () => {
  const c = { ...SRS.startCard(D), interval: 300, reps: 9 };
  assert.equal(SRS.review(c, 'easy', D).interval, SRS.MAX_INTERVAL);
  const frozen = SRS.startCard(D); const copy = JSON.stringify(frozen);
  SRS.review(frozen, 'good', D); assert.equal(JSON.stringify(frozen), copy);
  let h = SRS.startCard(D); for (let i = 0; i < 80; i++) h = SRS.review(h, 'good', D);
  assert.equal(h.log.length, 50);
  assert.throws(() => SRS.review(frozen, 'parfait', D), /inconnue/);
});

test('aperçu des délais sous les boutons, libellés et note suggérée', () => {
  const c = SRS.startCard(D);
  assert.deepEqual(SRS.previewIntervals(c, D), { again: 1, hard: 2, good: 3, easy: 5 });
  assert.equal(SRS.dueLabel('2026-11-12', D), 'aujourd\'hui');
  assert.equal(SRS.dueLabel('2026-11-13', D), 'demain');
  assert.equal(SRS.dueLabel('2026-11-18', D), 'dans 6 jours');
  assert.equal(SRS.dueLabel('2026-11-11', D), 'en retard d\'un jour');
  assert.equal(SRS.dueLabel('2026-11-09', D), 'en retard de 3 jours');
  assert.deepEqual([1, 20, 45, 400].map(SRS.intervalLabel), ['1 jour', '20 jours', '2 mois', '1 an']);
  assert.deepEqual([1, .9, .6, .5, .2, 0].map(SRS.suggestGrade), ['easy', 'easy', 'good', 'hard', 'again', 'again']);
  assert.equal(SRS.snooze({ ...c, due: D }, D, 1).due, '2026-11-13');
  assert.equal(SRS.snooze({ ...c, interval: 7, due: D }, D, 2).interval, 7);
});

/* ---- placement dans le calendrier */
const week = (over = {}) => ({ start: '2026-11-09', day_start: 8, day_end: 22, courses: [], blocks: [], sessions: [], ...over });
const item = (id, due) => ({ id, srs: { ...SRS.startCard('2026-11-01'), due } });
const at = (day, a, b) => ({ start: `${day}T${a}:00`, end: `${day}T${b}:00` });

test('un rappel dû va dans le premier trou libre du jour, après les cours et blocages (marge de 5 min)', () => {
  const w = week({ courses: [{ ...at(D, '08:00', '10:00'), subject: 'M' }], blocks: [{ day: D, start: '10:05', end: '12:00' }] });
  const [r] = SRS.placeReminders([item(1, D)], w, D, 0);
  assert.deepEqual([r.day, r.start, r.end], [D, '12:05', '12:20']);
});

test('un rappel en retard est posé aujourd\'hui, après l\'heure actuelle ; pas dans le passé', () => {
  const [r] = SRS.placeReminders([item(1, '2026-11-09')], week(), D, 14 * 60 + 2);
  assert.equal(r.day, D); assert.equal(r.start, '14:05'); assert.ok(r.late);
  assert.deepEqual(SRS.placeReminders([item(1, '2026-11-09')], week({ start: '2026-11-16' }), D, 0), []);   // semaine à venir : pas de retard
  assert.deepEqual(SRS.placeReminders([item(1, '2026-11-02')], week({ start: '2026-11-02' }), D, 0), []);   // semaine passée
});

test('rappel futur : le jour dû ; 3 par jour au plus, les suivants glissent au lendemain ; jamais de chevauchement', () => {
  const items = [1, 2, 3, 4, 5].map(i => item(i, '2026-11-13'));
  const out = SRS.placeReminders(items, week(), D, 0);
  const perDay = out.reduce((m, r) => ({ ...m, [r.day]: (m[r.day] || 0) + 1 }), {});
  assert.deepEqual(perDay, { '2026-11-13': 3, '2026-11-14': 2 });
  const sorted = out.filter(r => r.day === '2026-11-13').sort((a, b) => a.start.localeCompare(b.start));
  sorted.forEach((r, i) => i && assert.ok(r.start >= sorted[i - 1].end));
  assert.deepEqual(SRS.placeReminders([item(1, '2026-11-20')], week(), D, 0), []);                          // hors semaine affichée
});

test('journée pleine : on essaie les 2 jours suivants, sinon le rappel reste dans la liste seulement', () => {
  const full = d => ({ ...at(d, '08:00', '21:00'), subject: 'M' });
  const w = week({ courses: [full('2026-11-13')] });
  assert.equal(SRS.placeReminders([item(1, '2026-11-13')], w, D, 0)[0].day, '2026-11-14');
  const w2 = week({ courses: ['2026-11-13', '2026-11-14', '2026-11-15'].map(full) });
  assert.deepEqual(SRS.placeReminders([item(1, '2026-11-13')], w2, D, 0), []);
});

test('les créneaux de révision et blocages hebdomadaires comptent comme occupés', () => {
  const w = week({ sessions: [{ day: D, ...at(D, '08:00', '09:00') }], blocks: [{ day: D, start: '09:05', end: '10:00', recurring: true }] });
  assert.equal(SRS.placeReminders([item(1, D)], w, D, 0)[0].start, '10:05');
});

/* ---- quiz de l'IA */
test('quiz : JSON toléré avec texte et blocs de code autour, entrées invalides écartées, 8 cartes au plus', () => {
  const ok = parseQuiz('Voici :\n```json\n[{"q":" Qu\'est-ce que X ? ","a":"Y"},{"q":"Z ?","a":"W"}]\n```');
  assert.deepEqual(ok, [{ q: 'Qu\'est-ce que X ?', a: 'Y' }, { q: 'Z ?', a: 'W' }]);
  assert.equal(parseQuiz('[{"q":"seule","a":"carte"}]'), null);                  // trop peu de cartes
  assert.equal(parseQuiz('pas de json'), null);
  assert.equal(parseQuiz('[{"q":"a","a":"b"},{"q":1,"a":"b"},{"q":"","a":"b"}]'), null);
  assert.equal(parseQuiz('[1,2'), null);
  const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ q: `q${i}`, a: `a${i}` })));
  assert.equal(parseQuiz(many).length, 8);
  assert.match(quizRequest(7), /JSON/);
});

/* ---- bibliothèque */
test('bibliothèque : cours à revoir, plus en retard d\'abord, puis prochain rappel', async () => {
  const lib = await openLibrary(null);
  const mk = async (name, srs) => { const id = await lib.add({ subject: 'Maths', name, kind: 'text', size: 1, text: 'x' }); if (srs) await lib.update(id, { srs }); return id; };
  const a = await mk('a', { ...SRS.startCard('2026-11-01'), due: '2026-11-11' });
  const b = await mk('b', { ...SRS.startCard('2026-11-01'), due: '2026-11-09' });
  const c = await mk('c', { ...SRS.startCard('2026-11-01'), due: '2026-11-20' });
  await mk('sans rappel', null);
  const r = await lib.reviews(D);
  assert.deepEqual(r.due.map(x => x.id), [b, a]);
  assert.equal(r.next.id, c); assert.equal(r.total, 3);
  assert.equal((await lib.withSrs()).length, 3);
  assert.ok(!('text' in r.due[0]) && r.due[0].srs.due === '2026-11-09');
});

test('bibliothèque : le filtre « matières actives » écarte les cours des matières retirées', async () => {
  const lib = await openLibrary(null);
  const mk = async (subject, name) => { const id = await lib.add({ subject, name, kind: 'text', size: 1, text: 'x' }); await lib.update(id, { srs: { ...SRS.startCard('2026-11-01'), due: '2026-11-05' } }); return id; };
  const keepId = await mk('Maths', 'a'); await mk('Sport', 'b');
  const keep = r => r.subject === 'maths';
  assert.deepEqual((await lib.withSrs(keep)).map(x => x.id), [keepId]);
  const r = await lib.reviews('2026-11-12', keep);
  assert.deepEqual(r.due.map(x => x.id), [keepId]); assert.equal(r.total, 1);
  assert.equal((await lib.reviews('2026-11-12')).total, 2);
});
