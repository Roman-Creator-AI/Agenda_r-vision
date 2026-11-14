// Moteur de planification des révisions — port fidèle de planner.py (logique pure, testable).
//
// Règle : pour chaque occurrence d'un cours, on repère la prochaine occurrence (autre jour) de la même
// matière et on place la révision la veille (J-1) de celle-ci. S'il faut plusieurs créneaux, les suivants
// remontent à J-2, J-3... sans passer avant le cours précédent. Le compteur de retard (« dette ») d'une
// matière ajoute des créneaux de rattrapage dans les prochains cycles, jamais aujourd'hui.
import { sha1Hex } from './sha1.js';
import { MIN, addDays, dayToMs, dtToMs, msToDt, hmToMin, roundHalfEven, round2 } from './dates.js';
import { workType } from './kinds.js';

export const DEFAULT_CFG = {
  dayStart: 8 * 60, dayEnd: 21 * 60, preferredStart: 18 * 60,
  capacity: 180, historyDays: 7, groupBy: 'subject', extraCap: 2,
  examBoost: 0,          // créneaux ajoutés avant un examen (0 = comportement historique, identique à planner.py)
};

export const DEFAULT_SUBJECT = {
  color: '#2563eb', sessionMinutes: 60, chapters: 2, chaptersPerSession: 2,
  intensity: 1.0, enabled: true, backlog: 0,
  practiceMinutes: 0,    // durée d'un créneau d'exercices (TD/TP) ; 0 = même durée que pour un cours
};

const fold = s => String(s).toLowerCase();   // équivalent pratique de str.casefold()

/** (nombre de créneaux, durée en minutes de chacun) selon la charge paramétrée. */
export function workload(cfg) {
  const slots = Math.max(1, Math.ceil(Math.max(cfg.chapters, 1) / Math.max(cfg.chaptersPerSession, 1)));
  const minutes = roundHalfEven(cfg.sessionMinutes * Math.max(cfg.intensity, 0.1) / 5) * 5;
  return [slots, Math.max(minutes, 5)];
}

export function makeSid(subject, targetDay, idx, catchup = false) {
  const tag = catchup ? 'c' : 'b';   // les rattrapages ont leur propre série d'identifiants
  return sha1Hex(`${tag}|${fold(subject)}|${targetDay}|${idx}`).slice(0, 12);
}

// ------------------------------------------------------------------ occurrences
function prepareCourses(courses) {
  return courses.map(c => ({
    ...c, startMs: dtToMs(c.start), endMs: dtToMs(c.end), day: c.start.slice(0, 10),
  }));
}

export function consecutiveOccurrences(courses, groupBy = 'subject') {
  const groups = new Map();
  const sorted = [...courses].sort((a, b) => a.startMs - b.startMs);
  for (const c of sorted) {
    const key = fold(c.subject) + (groupBy === 'subject_kind' ? `|${fold(c.kind || '')}` : '');
    if (!groups.has(key)) groups.set(key, new Map());
    const days = groups.get(key);
    if (!days.has(c.day)) days.set(c.day, c);          // première occurrence du jour
  }
  const pairs = [];
  for (const days of groups.values()) {
    const ordered = [...days.keys()].sort().map(d => days.get(d));
    for (let i = 0; i + 1 < ordered.length; i++) pairs.push([ordered[i], ordered[i + 1]]);
  }
  return pairs;
}

// ------------------------------------------------------------------ placement
function merge(intervals) {
  const out = [];
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}

function freeGaps(busy, winStart, winEnd) {
  let cursor = winStart;
  const gaps = [];
  for (const [s, e] of merge(busy)) {
    if (e <= cursor) continue;
    if (s > cursor) gaps.push([cursor, Math.min(s, winEnd)]);
    cursor = Math.max(cursor, e);
    if (cursor >= winEnd) break;
  }
  if (cursor < winEnd) gaps.push([cursor, winEnd]);
  return gaps.filter(([s, e]) => e > s);
}

/** Premier créneau libre de `minutes` ; on préfère après `preferredStart`. */
export function findSlot(day, minutes, busy, cfg) {
  const base = dayToMs(day);
  const winS = base + cfg.dayStart * MIN, winE = base + cfg.dayEnd * MIN;
  const pref = Math.max(winS, base + cfg.preferredStart * MIN);
  const need = minutes * MIN;
  const gaps = freeGaps(busy, winS, winE);
  for (const [s, e] of gaps) {                    // 1) après l'heure préférée
    const start = Math.max(s, pref);
    if (e - start >= need) return { start, end: start + need, overloaded: false };
  }
  for (const [s, e] of gaps) {                    // 2) n'importe où dans la journée
    if (e - s >= need) return { start: s, end: s + need, overloaded: false };
  }
  const start = Math.max(winS, winE - need);      // 3) journée saturée : on signale la surcharge
  return { start, end: start + need, overloaded: true };
}

// ------------------------------------------------------------------ planification complète
function subjectCfg(subjects, name) {
  if (subjects[name]) return subjects[name];
  const key = Object.keys(subjects).find(k => fold(k) === fold(name));
  return key ? subjects[key] : { name, ...DEFAULT_SUBJECT };
}

/**
 * Génère les créneaux de révision.
 * `courses`  : [{subject, kind, start:'YYYY-MM-DDTHH:MM', end, room}]
 * `subjects` : {nom: {name, color, sessionMinutes, chapters, chaptersPerSession, intensity, enabled, backlog}}
 * `states`   : {sid: {status, moved_date, moved_start, minutes?, catchup, subject, target_day, idx}}
 *              (`minutes` : durée imposée à ce créneau, à la place de celle de la matière)
 * `blocks`   : [{day, start:'HH:MM', end:'HH:MM'}]
 */
export function plan(rawCourses, subjects, states, blocks, cfg = DEFAULT_CFG, today) {
  const courses = prepareCourses(rawCourses);
  const minDay = addDays(today, -cfg.historyDays);
  const busy = new Map();
  const addBusy = (day, s, e) => { if (!busy.has(day)) busy.set(day, []); busy.get(day).push([s, e]); };

  for (const c of courses) addBusy(c.day, c.startMs, c.endMs);
  for (const b of blocks) {
    const base = dayToMs(b.day);
    addBusy(b.day, base + hmToMin(b.start) * MIN, base + hmToMin(b.end) * MIN);
  }

  // 1) Créneaux souhaités, matière par matière
  const bySubject = new Map();
  for (const [prev, nxt] of consecutiveOccurrences(courses, cfg.groupBy)) {
    const key = fold(nxt.subject);
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push([prev, nxt]);
  }

  const wanted = [];
  const make = (scfg, nxt, day, idx, defaultMinutes, slots, catchup, chapters = []) => {
    const sid = makeSid(nxt.subject, nxt.day, idx, catchup);
    // Durée choisie à la main pour CE créneau (states[sid].minutes) : elle prime sur celle de la matière.
    const custom = Number(states[sid] && states[sid].minutes);
    const minutes = Number.isFinite(custom) && custom > 0 ? custom : defaultMinutes;
    const origin = dayToMs(day) + cfg.dayStart * MIN;
    return {
      sid, subject: scfg.name, targetMs: nxt.startMs,
      day, startMs: origin, endMs: origin + minutes * MIN, minutes, slotIndex: idx, slotCount: slots,
      status: 'pending', done: false, catchup, idx, moved: false, overloaded: false, chapters: [...chapters],
    };
  };

  for (const [key, items] of bySubject) {
    items.sort((a, b) => a[1].startMs - b[1].startMs);
    const scfg = subjectCfg(subjects, items[0][1].subject);
    if (!scfg.enabled) continue;
    const [slots, minutes] = workload(scfg);
    let remaining = Math.max(0, scfg.backlog || 0);
    for (const [prev, nxt] of items) {
      // Mode examen : on ne révise pas une séance venue après un examen, et l'examen reçoit plus de créneaux, étalés sur ~2 semaines.
      if (cfg.examBoost > 0 && workType(prev.kind) === 'exam') continue;
      const exam = cfg.examBoost > 0 && workType(nxt.kind) === 'exam';
      // Les exercices (TD/TP) peuvent avoir leur propre durée de créneau.
      const practice = scfg.practiceMinutes > 0 && workType(prev.kind) === 'practice';
      const [slots0, minutes0] = practice ? workload({ ...scfg, sessionMinutes: scfg.practiceMinutes }) : [slots, minutes];
      const slotsN = exam ? slots0 + cfg.examBoost : slots0;
      const targetDay = nxt.day, floorDay = exam ? addDays(targetDay, -14) : prev.day;
      const step = exam && slotsN <= 7 ? 2 : 1;
      // -- créneaux de base
      const per = Math.ceil(Math.max(scfg.chapters, 1) / slotsN);
      for (let i = 0; i < slotsN; i++) {
        const day = [addDays(targetDay, -(1 + i * step)), floorDay].sort().pop();      // max de deux dates ISO
        if (day < minDay) continue;
        const first = i * per + 1, last = Math.min(first + per - 1, Math.max(scfg.chapters, 1));
        const chapters = [];
        for (let n = first; n <= last; n++) chapters.push(n);
        wanted.push(make(scfg, nxt, day, i, minutes0, slotsN, false, chapters));
      }
      // -- rattrapages : ceux déjà connus (historique / déplacés) + ceux dus à la dette
      const retained = new Map();
      for (const [sid, st] of Object.entries(states)) {
        if (st.catchup && fold(st.subject || '') === key && st.target_day === targetDay &&
            st.idx !== null && st.idx !== undefined) retained.set(st.idx, sid);
      }
      let pendingRetained = 0;
      for (const sid of retained.values()) if ((states[sid].status || 'pending') === 'pending') pendingRetained++;
      let created = 0;
      // Un rattrapage n'est jamais placé aujourd'hui : il part dans un cycle dont la
      // fenêtre de révision (J-1 du cours) commence demain ou plus tard.
      if (targetDay >= addDays(today, 2)) {
        const want = Math.min(cfg.extraCap, remaining);
        created = Math.max(0, want - pendingRetained);
        remaining = Math.max(0, remaining - Math.max(want, pendingRetained));
      }
      const catchFloor = [floorDay, addDays(today, 1)].sort().pop();
      const indices = [...retained.keys()].sort((a, b) => a - b);
      const used = new Set(indices);
      let n = 0, j = 0;
      while (n < created) {
        if (!used.has(j)) { indices.push(j); used.add(j); n++; }
        j++;
      }
      for (const jj of indices) {
        // un rattrapage déjà vécu garde sa place ; les nouveaux ne partent pas dans le passé
        const lower = retained.has(jj) ? floorDay : catchFloor;
        const day = [addDays(targetDay, -(1 + slotsN + jj)), lower].sort().pop();
        if (day < minDay) continue;
        wanted.push(make(scfg, nxt, day, jj, minutes0, 0, true));
      }
    }
  }

  // 2) Créneaux déplacés par l'utilisateur : prioritaires
  const final = [], auto = [];
  for (const s of wanted) {
    const st = states[s.sid] || {};
    s.status = st.status || 'pending';
    s.done = s.status === 'done';
    if (st.moved_date && st.moved_start) {
      s.day = st.moved_date;
      s.startMs = dayToMs(s.day) + hmToMin(st.moved_start) * MIN;
      s.endMs = s.startMs + s.minutes * MIN;
      s.moved = true;
      if (s.status !== 'missed') addBusy(s.day, s.startMs, s.endMs);   // un « Non fait » libère sa plage
      final.push(s);
    } else auto.push(s);
  }

  // 3) Placement automatique des autres, dans l'ordre chronologique
  auto.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || a.targetMs - b.targetMs ||
                      (a.catchup - b.catchup) || a.idx - b.idx);
  for (const s of auto) {
    const slot = findSlot(s.day, s.minutes, busy.get(s.day) || [], cfg);
    s.startMs = slot.start; s.endMs = slot.end; s.overloaded = slot.overloaded;
    if (s.status !== 'missed') addBusy(s.day, s.startMs, s.endMs);
    final.push(s);
  }

  // 4) Chevauchements pour les créneaux déplacés à la main
  const live = final.filter(s => s.status !== 'missed');
  for (const s of live) {
    if (!s.moved) continue;
    s.overloaded = live.some(o => o !== s && o.day === s.day && o.startMs < s.endMs && s.startMs < o.endMs) ||
      courses.some(c => c.day === s.day && c.startMs < s.endMs && s.startMs < c.endMs);
  }

  final.sort((a, b) => a.startMs - b.startMs);
  return final.map(s => ({
    sid: s.sid, subject: s.subject, targetStart: msToDt(s.targetMs), day: s.day,
    start: msToDt(s.startMs), end: msToDt(s.endMs), minutes: s.minutes,
    slotIndex: s.slotIndex, slotCount: s.slotCount, done: s.done, status: s.status,
    catchup: s.catchup, idx: s.idx, moved: s.moved, overloaded: s.overloaded, chapters: s.chapters,
  }));
}

/** Minutes de révision par jour (hors « Non fait ») + niveau par rapport à la capacité. */
export function dailyLoad(sessions, capacity) {
  const out = {};
  for (const s of sessions) {
    if (s.status === 'missed') continue;
    const d = out[s.day] || (out[s.day] = { minutes: 0, done_minutes: 0 });
    d.minutes += s.minutes;
    if (s.done) d.done_minutes += s.minutes;
  }
  for (const d of Object.values(out)) {
    const ratio = capacity ? d.minutes / capacity : 0;
    Object.assign(d, {
      capacity, ratio: round2(ratio),
      level: ratio > 1 ? 'over' : ratio > 0.75 ? 'warn' : 'ok',
    });
  }
  return out;
}

