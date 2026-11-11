"""Dette de révision : statuts Fait / Non fait, compteur de retard, créneaux de rattrapage."""
import os
import sys
from datetime import date, datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import db  # noqa: E402
import planner as p  # noqa: E402
from config import Config  # noqa: E402

CFG = p.PlannerConfig(history_days=365)
TODAY = date(2026, 11, 9)


def thursdays(subject="Maths", n=5):
    first = datetime(2026, 11, 12, 10)
    return [p.Course(subject, "CM", first + timedelta(days=7 * i), first + timedelta(days=7 * i, hours=2))
            for i in range(n)]


def run(courses, backlog=0, states=None, cfg=CFG):
    subj = {"Maths": p.SubjectCfg("Maths", backlog=backlog)}
    return p.plan(courses, subj, states or {}, [], cfg, today=TODAY)


def base(sessions):
    return [s for s in sessions if not s.catchup]


def catchup(sessions):
    return [s for s in sessions if s.catchup]


# ---------------------------------------------------------------- planificateur
def test_no_debt_means_no_catchup():
    assert catchup(run(thursdays())) == []


def test_backlog_adds_catchup_in_first_upcoming_cycle():
    s = run(thursdays(), backlog=1)
    extra = catchup(s)
    assert len(extra) == 1
    assert extra[0].target_start.date() == date(2026, 11, 19)   # premier cycle à venir
    assert date(2026, 11, 12) <= extra[0].day < date(2026, 11, 19)
    assert len(base(s)) == 4                                    # la base ne change pas


def test_backlog_is_spread_with_cap_per_cycle():
    extra = catchup(run(thursdays(), backlog=5))                 # cap par défaut : 2
    per_cycle = {}
    for e in extra:
        per_cycle[e.target_start.date()] = per_cycle.get(e.target_start.date(), 0) + 1
    assert per_cycle == {date(2026, 11, 19): 2, date(2026, 11, 26): 2, date(2026, 12, 3): 1}


def test_catchup_never_goes_before_today_or_previous_course():
    extra = catchup(run(thursdays(), backlog=2))
    assert all(e.day >= TODAY and e.day >= date(2026, 11, 12) for e in extra)


def test_catchup_sid_differs_from_base_sid():
    s = run(thursdays(), backlog=1)
    assert len({x.sid for x in s}) == len(s)


def test_missed_session_frees_its_slot_and_is_excluded_from_load():
    courses = thursdays(n=2)
    first = run(courses)[0]
    s = run(courses, states={first.sid: {"status": "missed"}})[0]
    assert s.status == "missed" and not s.done
    assert p.daily_load([s], 180) == {}


def test_done_catchup_stays_visible_and_pending_ones_shrink():
    courses = thursdays()
    s0 = run(courses, backlog=2)
    c0 = catchup(s0)
    assert len(c0) == 2
    done = c0[0]
    states = {done.sid: {"status": "done", "catchup": 1, "subject": "Maths",
                         "target_day": done.target_start.date().isoformat(), "idx": done.idx}}
    # la dette a été remboursée : le compteur passe de 2 à 1
    s1 = run(courses, backlog=1, states=states)
    c1 = catchup(s1)
    assert sorted(x.status for x in c1) == ["done", "pending"]
    assert len(c1) == 2   # la session faite reste visible, une seule reste à faire


def test_missed_catchup_is_replanned_without_growing_debt():
    courses = thursdays()
    c0 = catchup(run(courses, backlog=1))[0]
    states = {c0.sid: {"status": "missed", "catchup": 1, "subject": "Maths",
                       "target_day": c0.target_start.date().isoformat(), "idx": c0.idx}}
    s = run(courses, backlog=1, states=states)
    statuses = sorted(x.status for x in catchup(s))
    assert statuses == ["missed", "pending"]    # un nouveau rattrapage remplace celui qui a été raté


def test_catchup_is_never_planned_today_nor_in_a_cycle_starting_today():
    # Aujourd'hui lundi 9 : cours le mardi 10 (révision aujourd'hui) puis le 17, 24...
    first = datetime(2026, 11, 3, 10)
    courses = [p.Course("Maths", "CM", first + timedelta(days=7 * i), first + timedelta(days=7 * i, hours=2))
               for i in range(5)]
    extra = catchup(run(courses, backlog=1))
    assert len(extra) == 1
    assert extra[0].target_start.date() == date(2026, 11, 17)     # on saute le cycle du 10
    assert extra[0].day > TODAY


# ---------------------------------------------------------------- base de données
@pytest.fixture()
def uid(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    user_id = db.create_user("roman", "hash")
    db.ensure_subjects(user_id, ["Maths"])
    return user_id


def meta(catchup=False, idx=0):
    return {"catchup": catchup, "subject": "Maths", "target_day": "2026-11-19", "idx": idx}


def backlog(uid):
    return db.list_subjects(uid)[0]["backlog"]


def test_missed_base_session_increments_backlog_once(uid):
    assert db.set_status(uid, "s1", meta(), "missed") == 1
    assert db.set_status(uid, "s1", meta(), "missed") == 1      # idempotent
    assert backlog(uid) == 1


def test_missed_sessions_accumulate(uid):
    db.set_status(uid, "s1", meta(), "missed")
    db.set_status(uid, "s2", meta(idx=1), "missed")
    assert backlog(uid) == 2


def test_undoing_missed_restores_backlog(uid):
    db.set_status(uid, "s1", meta(), "missed")
    db.set_status(uid, "s1", meta(), "pending")
    assert backlog(uid) == 0
    db.set_status(uid, "s1", meta(), "missed")
    db.set_status(uid, "s1", meta(), "done")
    assert backlog(uid) == 0


def test_done_catchup_repays_debt_and_never_goes_negative(uid):
    db.update_subject(uid, "Maths", {"backlog": 1})
    assert db.set_status(uid, "c1", meta(catchup=True), "done") == 0
    assert db.set_status(uid, "c2", meta(catchup=True, idx=1), "done") == 0   # plancher à 0


def test_manual_backlog_edit_and_user_isolation(uid):
    other = db.create_user("autre", "hash")
    db.ensure_subjects(other, ["Maths"])
    db.update_subject(uid, "Maths", {"backlog": 4})
    assert backlog(uid) == 4
    assert db.list_subjects(other)[0]["backlog"] == 0


def test_duplicate_username_is_rejected(uid):
    assert db.create_user("ROMAN", "x") is None      # insensible à la casse
