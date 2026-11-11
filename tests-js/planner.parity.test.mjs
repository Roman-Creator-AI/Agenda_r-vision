// Vérifie que le planificateur JavaScript (docs/js/planner.js) donne exactement les mêmes créneaux
// que le moteur Python (planner.py) sur des scénarios aléatoires. Lancer : node --test tests-js/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { plan, dailyLoad, workload } from '../docs/js/planner.js';
import { sha1Hex } from '../docs/js/sha1.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = Number(process.env.PARITY_CASES || 120);

function loadCases() {
  for (const py of ['python3', 'python']) {
    try {
      const out = execFileSync(py, [path.join(here, 'gen_fixtures.py'), String(CASES)],
        { maxBuffer: 1 << 28, encoding: 'utf8' });
      return JSON.parse(out);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return null;
}

test('sha1 : identique à la valeur de référence', () => {
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha1Hex('b|mathématiques 1|2026-11-12|0').length, 40);
});

test('workload : arrondi identique à Python (au pair le plus proche)', () => {
  assert.deepEqual(workload({ chapters: 6, chaptersPerSession: 2, sessionMinutes: 60, intensity: 1.5 }), [3, 90]);
  assert.deepEqual(workload({ chapters: 1, chaptersPerSession: 4, sessionMinutes: 25, intensity: 1.3 }), [1, 30]);
});

const cases = loadCases();
test(`parité JS/Python sur ${CASES} scénarios aléatoires`, { skip: !cases && 'Python introuvable' }, () => {
  let sessions = 0, catchups = 0, moved = 0, missed = 0;
  for (const c of cases) {
    const got = plan(c.courses, c.subjects, c.states, c.blocks, c.cfg, c.today);
    assert.deepEqual(got, c.expected, `scénario ${c.seed} : créneaux différents`);
    assert.deepEqual(dailyLoad(got, c.cfg.capacity), c.expectedLoad, `scénario ${c.seed} : charge différente`);
    sessions += got.length;
    catchups += got.filter(s => s.catchup).length;
    moved += got.filter(s => s.moved).length;
    missed += got.filter(s => s.status === 'missed').length;
  }
  // garde-fou : les scénarios doivent vraiment exercer rattrapages, déplacements et « Non fait »
  assert.ok(sessions > 500 && catchups > 20 && moved > 20 && missed > 20,
    `couverture insuffisante : ${JSON.stringify({ sessions, catchups, moved, missed })}`);
  console.log(`  ${cases.length} scénarios, ${sessions} créneaux (dont ${catchups} rattrapages, ${moved} déplacés, ${missed} « non fait ») identiques`);
});
