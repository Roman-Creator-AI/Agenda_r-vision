import os
import sys
from datetime import date, datetime, time, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import planner as p  # noqa: E402

CFG = p.PlannerConfig(history_days=365)
TODAY = date(2026, 11, 9)


def course(subject, y, m, d, h=10, dur=2, kind="CM"):
    s = datetime(y, m, d, h)
    return p.Course(subject, kind, s, s + timedelta(hours=dur))


def run(courses, subjects=None, states=None, blocks=None):
    return p.plan(courses, subjects or {}, states or {}, blocks or [], CFG, today=TODAY)


def test_revision_is_day_before_next_occurrence():
    # Maths jeudi 12 -> jeudi 19 : révision mercredi 18
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19)])
    assert len(s) == 1
    assert s[0].day == date(2026, 11, 18)
    assert s[0].target_start.date() == date(2026, 11, 19)


def test_three_occurrences_give_two_sessions():
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19), course("Maths", 2026, 11, 26)])
    assert [x.day for x in s] == [date(2026, 11, 18), date(2026, 11, 25)]


def test_last_occurrence_has_no_session():
    assert run([course("Maths", 2026, 11, 12)]) == []


def test_slot_placed_after_preferred_start_and_avoids_courses():
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19),
             course("Droit", 2026, 11, 18, h=17, dur=3)])  # cours jusqu'à 20h la veille
    assert s[0].start.time() >= time(20, 0)
    assert not s[0].overloaded


def test_workload_changes_duration_and_slot_count():
    cfg = p.SubjectCfg("Maths", session_minutes=60, chapters=6, chapters_per_session=2, intensity=1.5)
    assert p.workload(cfg) == (3, 90)
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19)], {"Maths": cfg})
    assert len(s) == 3 and all(x.minutes == 90 for x in s)
    assert sorted(x.day for x in s) == [date(2026, 11, 16), date(2026, 11, 17), date(2026, 11, 18)]


def test_spill_never_goes_before_previous_course():
    cfg = p.SubjectCfg("Maths", chapters=8, chapters_per_session=2)  # 4 créneaux
    s = run([course("Maths", 2026, 11, 17), course("Maths", 2026, 11, 19)], {"Maths": cfg})
    assert len(s) == 4 and all(x.day >= date(2026, 11, 17) for x in s)


def test_blocked_range_is_avoided():
    blocks = [p.Block(date(2026, 11, 18), time(18, 0), time(20, 0), "Sport")]
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19)], blocks=blocks)
    assert s[0].start.time() >= time(20, 0)


def test_moved_and_done_state_survive():
    base = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19)])
    sid = base[0].sid
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19)],
            states={sid: {"status": "done", "moved_date": "2026-11-16", "moved_start": "14:30"}})
    assert s[0].moved and s[0].done
    assert s[0].day == date(2026, 11, 16) and s[0].start.time() == time(14, 30)


def test_full_day_is_flagged_overloaded():
    cfg = p.SubjectCfg("Maths", session_minutes=60)
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19),
             course("Droit", 2026, 11, 18, h=8, dur=13)], {"Maths": cfg})
    assert s[0].overloaded


def test_daily_load_levels():
    s = run([course("Maths", 2026, 11, 12), course("Maths", 2026, 11, 19)],
            {"Maths": p.SubjectCfg("Maths", session_minutes=200)})
    load = p.daily_load(s, 180)
    assert load["2026-11-18"]["level"] == "over"
