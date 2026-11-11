"""Génère des scénarios aléatoires + le résultat de référence de planner.py (affiché en JSON).

Utilisé par planner.parity.test.mjs pour vérifier que docs/js/planner.js donne exactement les
mêmes créneaux que le moteur Python. Usage : python tests-js/gen_fixtures.py [nombre_de_cas]
"""
import json
import os
import random
import sys
from datetime import date, datetime, time, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import planner as p  # noqa: E402

NAMES = ["Mathématiques 1", "Physique", "Modélisation", "CIP", "Électronique", "Algèbre linéaire"]
KINDS = ["CM", "TD", "TP", "Cours"]


def iso(d):
    return d.isoformat(timespec="minutes")


def session_dict(s):
    return {"sid": s.sid, "subject": s.subject, "targetStart": iso(s.target_start), "day": s.day.isoformat(),
            "start": iso(s.start), "end": iso(s.end), "minutes": s.minutes, "slotIndex": s.slot_index,
            "slotCount": s.slot_count, "done": s.done, "status": s.status, "catchup": s.catchup,
            "idx": s.idx, "moved": s.moved, "overloaded": s.overloaded, "chapters": list(s.chapters)}


def make_case(seed):
    rnd = random.Random(seed)
    monday = date(2026, 9, 7) + timedelta(days=7 * rnd.randint(0, 6))
    weeks = rnd.randint(5, 10)
    today = monday + timedelta(days=rnd.randint(0, 7 * weeks - 1))
    names = rnd.sample(NAMES, rnd.randint(2, 4))
    courses, subjects = [], {}
    for name in names:
        subjects[name] = p.SubjectCfg(
            name, "#2563eb", rnd.choice([30, 45, 60, 90]), rnd.randint(1, 8), rnd.randint(1, 4),
            rnd.choice([0.5, 1.0, 1.25, 1.5, 2.0]), rnd.random() > 0.1, rnd.choice([0, 0, 0, 1, 2, 3, 5]))
        for _ in range(rnd.randint(1, 3)):
            wd, hour, kind = rnd.randint(0, 5), rnd.randint(8, 17), rnd.choice(KINDS)
            for w in range(weeks):
                if rnd.random() < 0.12:
                    continue
                start = datetime.combine(monday + timedelta(days=7 * w + wd), time(hour, rnd.choice([0, 15, 30, 45])))
                courses.append(p.Course(name, kind, start, start + timedelta(minutes=rnd.choice([60, 90, 120]))))
    blocks = []
    for _ in range(rnd.randint(0, 5)):
        d = today + timedelta(days=rnd.randint(-3, 25))
        h = rnd.randint(8, 19)
        blocks.append(p.Block(d, time(h, 0), time(min(h + rnd.randint(1, 3), 23), 0), "x"))
    cfg = p.PlannerConfig(
        day_start=time(rnd.choice([7, 8, 9]), 0), day_end=time(rnd.choice([20, 21, 22]), 0),
        preferred_start=time(rnd.choice([14, 17, 18, 19]), 0), capacity_minutes=rnd.choice([120, 180, 200, 240]),
        history_days=rnd.choice([3, 7, 14]), group_by=rnd.choice(["subject", "subject_kind"]),
        extra_cap=rnd.choice([1, 2, 3]))

    base = p.plan(courses, subjects, {}, blocks, cfg, today)
    states = {}
    for s in base:
        if rnd.random() < 0.45:
            st = {"status": rnd.choice(["done", "missed", "pending"]), "catchup": 1 if s.catchup else 0,
                  "subject": s.subject, "target_day": s.target_start.date().isoformat(), "idx": s.idx,
                  "moved_date": None, "moved_start": None}
            if rnd.random() < 0.3:
                st["moved_date"] = (s.day + timedelta(days=rnd.randint(-1, 3))).isoformat()
                st["moved_start"] = f"{rnd.randint(8, 21):02d}:{rnd.choice(['00', '15', '30', '45'])}"
            states[s.sid] = st
    for sub in subjects.values():            # la dette peut avoir changé depuis (saisie manuelle)
        if rnd.random() < 0.4:
            sub.backlog = rnd.choice([0, 1, 2, 4])
    sessions = p.plan(courses, subjects, states, blocks, cfg, today)
    load = p.daily_load(sessions, cfg.capacity_minutes)
    return {
        "seed": seed, "today": today.isoformat(),
        "courses": [{"subject": c.subject, "kind": c.kind, "start": iso(c.start), "end": iso(c.end), "room": ""}
                    for c in courses],
        "subjects": {n: {"name": n, "color": s.color, "sessionMinutes": s.session_minutes, "chapters": s.chapters,
                         "chaptersPerSession": s.chapters_per_session, "intensity": s.intensity,
                         "enabled": s.enabled, "backlog": s.backlog} for n, s in subjects.items()},
        "states": {sid: {**st, "catchup": bool(st["catchup"])} for sid, st in states.items()},
        "blocks": [{"day": b.day.isoformat(), "start": b.start.strftime("%H:%M"), "end": b.end.strftime("%H:%M")}
                   for b in blocks],
        "cfg": {"dayStart": cfg.day_start.hour * 60, "dayEnd": cfg.day_end.hour * 60,
                "preferredStart": cfg.preferred_start.hour * 60, "capacity": cfg.capacity_minutes,
                "historyDays": cfg.history_days, "groupBy": cfg.group_by, "extraCap": cfg.extra_cap},
        "expected": [session_dict(s) for s in sessions], "expectedLoad": load,
    }


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    json.dump([make_case(i) for i in range(1, n + 1)], sys.stdout)
