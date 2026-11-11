// Le lecteur ICS JavaScript (ical.js) doit donner les mêmes cours que le lecteur Python (icalendar)
// sur un fichier volontairement piégé : fuseaux, heure d'été, exceptions, occurrences déplacées...
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseICS, parseSummary, fetchICS, IcsError } from '../docs/js/ics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TODAY = '2026-11-10';

export const SAMPLE = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//FR',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Paris',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE',
  // 1. hebdomadaire avec TZID, à cheval sur le passage à l'heure d'hiver (25 octobre)
  'BEGIN:VEVENT', 'UID:cip@x', 'SUMMARY:CIP - FR - CM 3 (120) - S8', 'LOCATION:Amphi /Centre de Langues/\\, Eiffel',
  'DTSTART;TZID=Europe/Paris:20261013T081500', 'DTEND;TZID=Europe/Paris:20261013T094500',
  'RRULE:FREQ=WEEKLY;COUNT=12', 'END:VEVENT',
  // 2. hebdomadaire en UTC : l'heure murale change avec l'heure d'été
  'BEGIN:VEVENT', 'UID:maths@x', 'SUMMARY:Mathématiques 1 - CS+R - CM - S12', 'LOCATION:Amphi I\\, Eiffel',
  'DTSTART:20261015T104500Z', 'DTEND:20261015T114500Z', 'RRULE:FREQ=WEEKLY;COUNT=8', 'END:VEVENT',
  // 3. heure flottante avec une date exclue (EXDATE)
  'BEGIN:VEVENT', 'UID:phys@x', 'SUMMARY:Physique (TD)', 'DTSTART:20261102T140000', 'DTEND:20261102T160000',
  'RRULE:FREQ=WEEKLY;COUNT=6', 'EXDATE:20261116T140000', 'END:VEVENT',
  // 4. occurrence déplacée (RECURRENCE-ID) du 11/11 vers le 12/11 à 15h
  'BEGIN:VEVENT', 'UID:mv@x', 'SUMMARY:Algèbre - FR - TD - S3', 'DTSTART;TZID=Europe/Paris:20261104T100000',
  'DTEND;TZID=Europe/Paris:20261104T120000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:mv@x', 'RECURRENCE-ID;TZID=Europe/Paris:20261111T100000', 'SUMMARY:Algèbre - FR - TD - S3',
  'DTSTART;TZID=Europe/Paris:20261112T150000', 'DTEND;TZID=Europe/Paris:20261112T170000', 'END:VEVENT',
  // 5. toute la journée (ignoré) et 6. jour férié (ignoré par le filtre)
  'BEGIN:VEVENT', 'UID:day@x', 'SUMMARY:Journée portes ouvertes', 'DTSTART;VALUE=DATE:20261118', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:fer@x', 'SUMMARY:Jour férié - Armistice', 'DTSTART:20261111T080000Z', 'DTEND:20261111T090000Z', 'END:VEVENT',
  // 7. DURATION au lieu de DTEND
  'BEGIN:VEVENT', 'UID:proj@x', 'SUMMARY:Projet - FR - S1', 'DTSTART;TZID=Europe/Paris:20261120T090000',
  'DURATION:PT1H30M', 'END:VEVENT',
  // 8. ni fin ni durée (1 h par défaut), titre sans " - ", ligne repliée
  'BEGIN:VEVENT', 'UID:tp@x', 'SUMMARY:TP Électronique numé', ' rique', 'DTSTART:20261123T160000Z', 'END:VEVENT',
  // 9. TZID IANA sans VTIMEZONE dans le fichier
  'BEGIN:VEVENT', 'UID:ny@x', 'SUMMARY:Visio - US - CM', 'DTSTART;TZID=America/New_York:20261117T090000',
  'DTEND;TZID=America/New_York:20261117T103000', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

const WINDOW = ['2026-10-11', '2027-04-09'];

function pythonReference(text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ics-'));
  const file = path.join(dir, 'sample.ics');
  writeFileSync(file, text);
  for (const py of ['python3', 'python']) {
    try {
      return JSON.parse(execFileSync(py, [path.join(here, 'gen_ics_ref.py'), file, ...WINDOW], { encoding: 'utf8' }));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return null;
}

test('lecteur ICS JS = lecteur Python (fuseaux, heure d\'été, EXDATE, exceptions, durées)', t => {
  const ref = pythonReference(SAMPLE);
  if (!ref) return t.skip('Python introuvable');
  const got = parseICS(SAMPLE, { today: TODAY, pastDays: 30, futureDays: 150 });
  assert.deepEqual(got.map(c => [c.start, c.end, c.subject, c.kind]), ref.map(c => [c.start, c.end, c.subject, c.kind]));
  assert.deepEqual(got, ref);
  assert.ok(got.length > 30, `trop peu de cours : ${got.length}`);
});

test('cas précis : heure d\'été, exception déplacée, EXDATE, jour férié', () => {
  const got = parseICS(SAMPLE, { today: TODAY });
  const at = s => got.find(c => c.start === s);
  assert.equal(at('2026-10-15T12:45')?.subject, 'Mathématiques 1');      // 10:45Z en heure d'été (+2)
  assert.equal(at('2026-11-12T11:45')?.subject, 'Mathématiques 1');      // 10:45Z en heure d'hiver (+1)
  assert.equal(at('2026-10-27T08:15')?.subject, 'CIP');                  // l'heure murale ne bouge pas (TZID)
  assert.ok(!got.some(c => c.start === '2026-11-16T14:00'), 'EXDATE ignorée');
  assert.ok(!got.some(c => c.start === '2026-11-11T10:00'), 'occurrence d\'origine remplacée');
  assert.equal(at('2026-11-12T15:00')?.end, '2026-11-12T17:00');          // occurrence déplacée
  assert.ok(!got.some(c => /Armistice|portes ouvertes/.test(c.summary)), 'férié et jour entier ignorés');
  assert.equal(at('2026-11-17T15:00')?.subject, 'Visio');                 // New York 09:00 -> Paris 15:00
  assert.equal(at('2026-11-20T09:00')?.end, '2026-11-20T10:30');          // DURATION
  assert.equal(at('2026-11-23T17:00')?.end, '2026-11-23T18:00');          // 1 h par défaut
});

test('parseSummary : formats Geode et variantes', () => {
  assert.deepEqual(parseSummary('Mathématiques 1 - CS+R - CM - S12'), ['Mathématiques 1', 'CM']);
  assert.deepEqual(parseSummary('CIP - FR - CM 3 (120) - S8'), ['CIP', 'CM']);
  assert.deepEqual(parseSummary('Modélisation  - FR - Voie B Gr 03 (35) - S2'), ['Modélisation', 'Cours']);
  assert.deepEqual(parseSummary('Physique (TD)'), ['Physique', 'TD']);
  assert.deepEqual(parseSummary('TP Électronique numérique'), ['Électronique numérique', 'TP']);
  assert.deepEqual(parseSummary('Algèbre - travaux dirigé'), ['Algèbre', 'TD']);     // « é » final : \b JS échouerait
  assert.deepEqual(parseSummary(''), ['Sans titre', 'Cours']);
});

test('fichiers invalides ou trop gros', () => {
  assert.throws(() => parseICS('pas un calendrier', { today: TODAY }), IcsError);
  assert.throws(() => parseICS('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'.repeat(1) + 'x'.repeat(6 * 1024 * 1024), { today: TODAY }), IcsError);
  assert.deepEqual(parseICS('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', { today: TODAY }), []);
});

test('fetchICS : webcal, erreurs HTTP et blocage CORS', async () => {
  const seen = [];
  const ok = async url => { seen.push(url); return { ok: true, text: async () => 'BEGIN:VCALENDAR' }; };
  assert.equal(await fetchICS('webcal://geode.example/abc.ics', ok), 'BEGIN:VCALENDAR');
  assert.equal(seen[0], 'https://geode.example/abc.ics');
  await assert.rejects(fetchICS('ftp://x/y.ics', ok), IcsError);
  await assert.rejects(fetchICS('https://x/y.ics', async () => ({ ok: false, status: 403 })), /403/);
  await assert.rejects(fetchICS('https://x/y.ics', async () => { throw new TypeError('Failed to fetch'); }), /CORS/);
});
