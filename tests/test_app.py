"""Tests de l'application complète : comptes, sécurité, isolation et suivi de la dette."""
import io
import os
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import app as appmod  # noqa: E402
from config import Config  # noqa: E402

PASSWORD = "un-mot-de-passe-solide"


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(Config, "SECRET_KEY", "cle-de-test")
    monkeypatch.setattr(Config, "ALLOW_REGISTRATION", True)
    monkeypatch.setattr(Config, "INVITE_CODE", "")
    return appmod.create_app()


def new_client(app):
    return app.test_client()


def token(c):
    """Charge la page (qui fixe le jeton CSRF dans la session) puis le lit, comme le navigateur."""
    c.get("/")
    with c.session_transaction() as s:
        return s["csrf"]


def hdr(c):
    return {"X-CSRF-Token": token(c)}


def register(c, name="roman", password=PASSWORD, **extra):
    return c.post("/register", data={"csrf_token": token(c), "username": name, "password": password,
                                     "confirm": password, **extra})


def login(c, name="roman", password=PASSWORD):
    return c.post("/login", data={"csrf_token": token(c), "username": name, "password": password})


def logout(c):
    return c.post("/logout", data={"csrf_token": token(c)})


def ics(past_days=9):
    start = (date.today() - timedelta(days=past_days)).strftime("%Y%m%dT100000")
    return (f"BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//t//EN\nBEGIN:VEVENT\nUID:m@x\n"
            f"SUMMARY:Maths - FR - CM - S1\nDTSTART:{start}\nDTEND:{start[:9]}120000\n"
            f"RRULE:FREQ=WEEKLY;COUNT=10\nEND:VEVENT\nEND:VCALENDAR\n").encode()


def upload(c, data=None):
    return c.post("/api/upload", data={"file": (io.BytesIO(data or ics()), "edt.ics")}, headers=hdr(c),
                  content_type="multipart/form-data")


def agenda(c):
    return c.get("/api/agenda").json["sessions"]


def backlog(c):
    return c.get("/api/subjects").json[0]["backlog"]


# ---------------------------------------------------------------- accès et sécurité
def test_login_required_and_public_pages(app):
    c = new_client(app)
    assert c.get("/api/today").status_code == 401
    page = c.get("/")
    assert page.status_code == 200 and "Se connecter" in page.get_data(as_text=True)
    assert c.get("/healthz").json == {"ok": True}


def test_csrf_is_enforced(app):
    c = app.test_client()                                   # pas de jeton en session
    assert c.post("/login", data={"username": "x", "password": "y"}).status_code == 403
    c2 = new_client(app)
    register(c2)
    assert c2.post("/api/blocks", json={}).status_code == 403                  # jeton absent
    assert c2.post("/api/blocks", json={}, headers={"X-CSRF-Token": "faux"}).status_code == 403


def test_security_headers(app):
    r = new_client(app).get("/")
    assert r.headers["X-Frame-Options"] == "DENY" and r.headers["X-Content-Type-Options"] == "nosniff"


def test_register_login_logout(app):
    c = new_client(app)
    assert register(c).status_code == 302
    assert c.get("/api/me").json == {"username": "roman"}
    logout(c)
    assert c.get("/api/me").status_code == 401
    assert login(c, password="mauvais-mot-de-passe").status_code == 401
    assert login(c).status_code == 302
    assert c.get("/api/me").status_code == 200


def test_password_is_hashed_in_database(app):
    import db
    register(new_client(app))
    stored = db.get_user_by_name("roman")["password_hash"]
    assert PASSWORD not in stored and stored.split("$")[0] in {"scrypt:32768:8:1", "pbkdf2:sha256:600000"} \
        or stored.startswith(("scrypt:", "pbkdf2:"))


def test_registration_validation(app):
    c = new_client(app)
    assert register(c, password="court").status_code == 400
    assert register(c, name="a b").status_code == 400
    assert register(c, name="roman", password="roman-roman-roman").status_code == 400   # contient l'identifiant
    assert register(new_client(app), name="Roman").status_code == 302
    assert register(new_client(app), name="roman").status_code == 409                   # insensible à la casse


def test_invite_code_and_closed_registration(app, monkeypatch):
    monkeypatch.setattr(Config, "INVITE_CODE", "sesame")
    assert register(new_client(app), invite="faux").status_code == 403
    assert register(new_client(app), invite="sesame").status_code == 302
    monkeypatch.setattr(Config, "ALLOW_REGISTRATION", False)
    assert register(new_client(app), name="autre").status_code == 403


def test_login_is_throttled_after_repeated_failures(app):
    c = new_client(app)
    register(c)
    logout(c)
    for _ in range(Config.LOGIN_MAX_FAILURES):
        assert login(c, password="mauvais-mot-de-passe").status_code == 401
    assert login(c).status_code == 429          # même le bon mot de passe est refusé un moment


def test_change_password(app):
    c = new_client(app)
    register(c)
    assert c.post("/api/password", json={"current": "faux", "new": "nouveau-mot-de-passe"}, headers=hdr(c)).status_code == 403
    assert c.post("/api/password", json={"current": PASSWORD, "new": "court"}, headers=hdr(c)).status_code == 400
    assert c.post("/api/password", json={"current": PASSWORD, "new": "nouveau-mot-de-passe"}, headers=hdr(c)).status_code == 200
    logout(c)
    assert login(c).status_code == 401
    assert login(c, password="nouveau-mot-de-passe").status_code == 302


# ---------------------------------------------------------------- isolation
def test_users_cannot_see_or_modify_each_other(app):
    a, b = new_client(app), new_client(app)
    register(a, "alice-a")
    register(b, "bob-b")
    assert upload(a).status_code == 200
    sid = agenda(a)[0]["id"]
    assert agenda(b) == [] and b.get("/api/subjects").json == []
    assert b.patch(f"/api/sessions/{sid}", json={"status": "done"}, headers=hdr(b)).status_code == 404
    assert a.get("/api/subjects").json[0]["backlog"] == 0


# ---------------------------------------------------------------- suivi et dette
def test_missed_session_feeds_backlog_and_schedules_catchup_then_repays(app):
    c = new_client(app)
    register(c)
    assert upload(c).json["count"] == 10
    past = next(s for s in agenda(c) if s["day"] == (date.today() - timedelta(days=3)).isoformat()
                and not s["catchup"])
    assert past["status"] == "pending" and past["overdue"]

    # « Non fait » : +1 de retard, et un rattrapage apparaît dans un cycle futur (jamais aujourd'hui)
    r = c.patch(f"/api/sessions/{past['id']}", json={"status": "missed"}, headers=hdr(c))
    assert r.json["backlog"] == 1 and backlog(c) == 1
    catchups = [s for s in agenda(c) if s["catchup"]]
    assert len(catchups) == 1 and catchups[0]["day"] > date.today().isoformat()
    # la session ratée n'est plus dans la to-do du jour
    assert past["id"] not in {s["id"] for s in c.get("/api/today").json["todo"]}
    # idempotent
    c.patch(f"/api/sessions/{past['id']}", json={"status": "missed"}, headers=hdr(c))
    assert backlog(c) == 1

    # le rattrapage est fait : la dette est remboursée, la session reste visible comme faite
    r = c.patch(f"/api/sessions/{catchups[0]['id']}", json={"status": "done"}, headers=hdr(c))
    assert r.json["backlog"] == 0
    states = sorted(s["status"] for s in agenda(c) if s["catchup"])
    assert states == ["done"]

    # on annule le « Non fait » : retour à l'état initial
    c.patch(f"/api/sessions/{past['id']}", json={"status": "pending"}, headers=hdr(c))
    assert next(s for s in agenda(c) if s["id"] == past["id"])["status"] == "pending"


def test_manual_backlog_adds_capped_catchups_per_cycle(app):
    c = new_client(app)
    register(c)
    upload(c)
    r = c.put("/api/subjects", json={"name": "Maths", "backlog": 3}, headers=hdr(c))
    assert r.status_code == 200 and backlog(c) == 3
    per_cycle = {}
    for s in agenda(c):
        if s["catchup"]:
            per_cycle[s["target"][:10]] = per_cycle.get(s["target"][:10], 0) + 1
    assert sorted(per_cycle.values(), reverse=True) == [Config.EXTRA_CAP_PER_CYCLE, 3 - Config.EXTRA_CAP_PER_CYCLE]
    assert c.put("/api/subjects", json={"name": "Maths", "backlog": -1}, headers=hdr(c)).status_code == 400
    assert c.put("/api/subjects", json={"name": "Maths", "backlog": 0}, headers=hdr(c)).status_code == 200
    assert not [s for s in agenda(c) if s["catchup"]]


def test_workload_recalculates_when_subject_settings_change(app):
    c = new_client(app)
    register(c)
    upload(c)
    before = c.get("/api/subjects").json[0]
    c.put("/api/subjects", json={"name": "Maths", "chapters": 6, "intensity": 1.5}, headers=hdr(c))
    after = c.get("/api/subjects").json[0]
    assert (before["slots"], after["slots"]) == (1, 3) and after["slot_minutes"] == 90


def test_unsafe_ics_url_is_refused(app):
    c = new_client(app)
    register(c)
    r = c.post("/api/sync", json={"url": "http://127.0.0.1:8000/x.ics"}, headers=hdr(c))
    assert r.status_code == 502
