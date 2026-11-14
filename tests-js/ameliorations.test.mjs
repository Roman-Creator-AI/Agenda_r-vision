// Replanification (créneau libre, répartition des retards, priorités) et export calendrier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyIntervals, freeSlot, spreadSessions, prioritize, toMin } from '../docs/js/scheduling.js';
import { buildIcs } from '../docs/js/ics-export.js';
import { parseICS } from '../docs/js/ics.js';

const week = {
  courses: [{ start: '2026-11-16T09:00', end: '2026-11-16T12:00' }],
  blocks: [{ day: '2026-11-16', start: '12:00', end: '13:30' }],
  sessions: [{ id: 'a', day: '2026-11-16', start: '2026-11-16T14:00', end: '2026-11-16T15:00' },
             { id: 'b', day: '2026-11-17', start: '2026-11-17T08:00', end: '2026-11-17T09:00' }],
};

test('plages occupées : cours, blocages et autres créneaux du jour (sauf celui qu\'on déplace)', () => {
  assert.deepEqual(busyIntervals(week, '2026-11-16'), [[540, 720], [720, 810], [840, 900]]);
  assert.deepEqual(busyIntervals(week, '2026-11-16', 'a'), [[540, 720], [720, 810]]);
  assert.deepEqual(busyIntervals(week, '2026-11-18'), []);
});

test('premier créneau libre : saute les cours, garde l\'heure souhaitée si libre, évite le passé', () => {
  const busy = busyIntervals(week, '2026-11-16');
  assert.equal(freeSlot(busy, 60), '08:00');                                   // avant le cours de 9h
  assert.equal(freeSlot(busy, 90), '15:00');                                   // 8h-9h trop court ; 13h30 chevaucherait le créneau de 14h
  assert.equal(freeSlot(busy, 60, { prefer: '16:00' }), '16:00');              // heure d'origine libre : conservée
  assert.equal(freeSlot(busy, 60, { prefer: '14:00' }), '08:00');              // occupée : premier créneau libre
  assert.equal(freeSlot(busy, 60, { notBefore: toMin('10:07') }), '15:00');    // cours jusqu'à 12h, blocage jusqu'à 13h30, créneau de 14h à 15h : pas dans le passé
  assert.equal(freeSlot([[480, 1320]], 30), null);                             // journée pleine
  assert.equal(freeSlot([], 60, { notBefore: toMin('08:01') }), '08:15');      // arrondi au quart d'heure
});

test('répartition des retards : jour le moins chargé, en tenant compte de ce qu\'on vient de placer', () => {
  const days = [
    { day: '2026-11-13', load: 150, capacity: 180, busy: [] },
    { day: '2026-11-14', load: 0, capacity: 180, busy: [] },
    { day: '2026-11-15', load: 60, capacity: 180, busy: [] },
  ];
  const sessions = [{ id: 's1', minutes: 90 }, { id: 's2', minutes: 90 }, { id: 's3', minutes: 90 }];
  const r = spreadSessions(sessions, days);
  assert.deepEqual(r.moves.map(m => m.day), ['2026-11-14', '2026-11-15', '2026-11-14']);   // 0 → 90, 60 → 150, puis 90 < 150 < 150+
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.over, 0);
  // deux créneaux le même jour ne se chevauchent pas
  const same = r.moves.filter(m => m.day === '2026-11-14').map(m => toMin(m.start)).sort((a, b) => a - b);
  assert.ok(same[1] - same[0] >= 90);
});

test('répartition : signale les dépassements et les créneaux sans place', () => {
  const full = [{ day: '2026-11-13', load: 170, capacity: 180, busy: [] }];
  const r = spreadSessions([{ id: 'x', minutes: 60 }], full);
  assert.equal(r.moves.length, 1);
  assert.equal(r.over, 1);
  const none = spreadSessions([{ id: 'y', minutes: 60 }], [{ day: '2026-11-13', load: 0, capacity: 180, busy: [[480, 1320]] }]);
  assert.deepEqual(none.unplaced, ['y']);
});

test('priorités : les matières en retard d\'abord, puis le cours le plus proche', () => {
  const mk = (subject, day, target, status = 'pending', minutes = 60) => ({ subject, color: '#000', day, target, status, minutes });
  const list = prioritize([
    mk('Physique', '2026-11-14', '2026-11-16T09:00'),
    mk('Maths', '2026-11-13', '2026-11-14T09:00'),
    mk('SIP', '2026-11-08', '2026-11-09T09:00'),                                // en retard
    mk('SIP', '2026-11-14', '2026-11-20T09:00'),
    mk('Chimie', '2026-11-13', '2026-11-14T09:00', 'done'),                     // déjà fait : ignoré
  ], '2026-11-13');
  assert.deepEqual(list.map(g => g.subject), ['SIP', 'Maths', 'Physique']);
  assert.equal(list[0].late, 1);
  assert.equal(list[0].count, 2);
});

test('export .ics : seuls les créneaux à venir, alerte avant, relu par notre propre lecteur ICS', () => {
  const mk = (id, day, status, subject = 'Mathématiques 1') => ({ id, subject, day, status, start: `${day}T18:00`, end: `${day}T19:30`,
    target: `${day.slice(0, 8)}20T09:00`, chapters: [1, 2], catchup: false });
  const { text, count } = buildIcs([mk('aaa111', '2026-11-14', 'pending'), mk('bbb222', '2026-11-12', 'pending'),
                                    mk('ccc333', '2026-11-15', 'done'), mk('ddd444', '2026-11-16', 'pending', 'Sciences, Transferts; ok')],
                                   { today: '2026-11-13', now: new Date('2026-11-13T09:00:00Z') });
  assert.equal(count, 2);
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(text, /DTSTART:20261114T180000\r\n/);
  assert.match(text, /TRIGGER:-PT30M/);
  assert.ok(!text.includes('bbb222') && !text.includes('ccc333'));
  assert.match(text, /Sciences\\, Transferts\\; ok/);                           // virgule et point-virgule échappés
  for (const line of text.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `ligne trop longue : ${line}`);
  const parsed = parseICS(text, { today: '2026-11-13' });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].start, '2026-11-14T18:00');
});

// ---------------------------------------------------------------- cours (à apprendre) / TD (exercices)
import { workType, workOf, kindNoun, unitRange, guessTopic } from '../docs/js/kinds.js';
import { forTopic } from '../docs/js/ai.js';

test('types de séance : CM = à apprendre, TD/TP = exercices, le reste = réviser', () => {
  for (const k of ['CM', 'Cours', 'cours magistral', 'Amphi', '', undefined, 'Cours 2']) assert.equal(workOf(k), 'learn', String(k));
  for (const k of ['TD', 'TD 3', 'TP', 'Travaux dirigés', 'Exercices', 'td/tp']) assert.equal(workOf(k), 'practice', String(k));
  for (const k of ['Examen', 'DS', 'Projet', 'Séminaire']) assert.equal(workOf(k), 'review', String(k));
  assert.equal(workType('Examen'), 'exam');
  assert.equal(workType('Projet'), 'project');
  assert.equal(kindNoun('Cours'), 'cours'); assert.equal(kindNoun('TD'), 'TD'); assert.equal(kindNoun(''), 'cours');
  assert.equal(unitRange('learn', [1, 2]), 'chap. 1–2');
  assert.equal(unitRange('practice', [1]), 'série 1');
  assert.equal(unitRange('learn', []), '');
});

test('type de document deviné d\'après le nom du fichier', () => {
  for (const n of ['TD3.pdf', 'td_2_algebre.pdf', 'TP 4 - réseaux.docx', 'Feuille d\'exercices 5.pdf', 'exo_limites.pdf', 'Corrigé DS 2024.pdf', 'serie3.pdf', 'sujet-partiel.pdf']) assert.equal(guessTopic(n), 'td', n);
  for (const n of ['Cours 1.pdf', 'chapitre2.pptx', 'CM_integrales.pdf', 'résumé.docx', 'tdsb-intro.pdf'.replace('tdsb', 'introduction')]) assert.equal(guessTopic(n), 'cours', n);
});

test('assistant : un TD ne se résume pas, il se travaille (prompts et libellés différents)', () => {
  const c = forTopic('cours'), t = forTopic('td');
  assert.equal(forTopic(undefined), c);
  assert.notEqual(t.summaryRequest, c.summaryRequest);
  assert.match(t.summaryRequest, /Ne donne PAS les solutions/);
  assert.match(t.system({ subject: 'Maths', title: 'TD1', text: 'ex 1' }), /<exercices>[\s\S]*ex 1[\s\S]*<\/exercices>/);
  assert.match(t.system({ subject: 'Maths', title: 'TD1', text: 'x' }), /indice/);
  assert.match(c.system({ subject: 'Maths', title: 'Cours 1', text: 'x' }), /<cours>/);
  assert.match(t.quizRequest(3), /exercices d'entraînement/);
  assert.match(c.quizRequest(3), /questions de rappel/);
  assert.equal(t.item, 'Exercice'); assert.equal(c.item, 'Question');
});

test('priorités : compte ce qui est à apprendre et ce qui est en exercices', () => {
  const mk = (day, work) => ({ subject: 'Maths', color: '#000', day, target: '2026-11-20T09:00', status: 'pending', minutes: 60, work });
  const [g] = prioritize([mk('2026-11-14', 'learn'), mk('2026-11-15', 'practice'), mk('2026-11-16', 'practice')], '2026-11-13');
  assert.equal(g.learn, 1); assert.equal(g.practice, 2);
});

test('export .ics : « Apprendre » ou « Exercices » selon la séance révisée', () => {
  const mk = (id, work, srcKind) => ({ id, subject: 'Maths', day: '2026-11-14', status: 'pending', start: '2026-11-14T18:00', end: '2026-11-14T19:00', target: '2026-11-17T09:00',
    chapters: [1], catchup: false, work, source_kind: srcKind, source_day: '2026-11-10', target_kind: 'TD' });
  const { text } = buildIcs([mk('a1', 'learn', 'CM'), mk('b2', 'practice', 'TD')], { today: '2026-11-13', now: new Date('2026-11-13T09:00:00Z') });
  assert.match(text, /SUMMARY:📖 Apprendre le cours : Maths/);
  assert.match(text, /SUMMARY:✏️ Refaire les exercices : Maths/);
  assert.match(text.replace(/\r\n /g, ''), /avant le TD du/);                      // les lignes longues sont repliées (RFC 5545)
});
