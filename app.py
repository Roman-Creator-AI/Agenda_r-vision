"""Application Flask : comptes utilisateurs, API JSON et interface (templates/)."""
import logging
import os
import re
import secrets
import threading
from collections import defaultdict
from datetime import date, datetime, time, timedelta

from flask import Flask, g, jsonify, redirect, render_template, request, session
from werkzeug.middleware.proxy_fix import ProxyFix

import auth
import db
import planner
from config import Config
from ics_service import IcsError, fetch_ics, parse_ics

log = logging.getLogger("revisions")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
STATUSES = {"pending", "done", "missed"}


def _secret_key() -> str:
    """SECRET_KEY de l'environnement ; sinon une clé générée et conservée dans data/.secret_key."""
    if Config.SECRET_KEY:
        return Config.SECRET_KEY
    path = Config.DB_PATH.parent / ".secret_key"
    try:
        if path.exists():
            return path.read_text().strip()
        key = secrets.token_hex(32)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key)
        os.chmod(path, 0o600)
        log.warning("SECRET_KEY absente : clé générée dans %s. En ligne, définissez SECRET_KEY.", path)
        return key
    except OSError:
        log.warning("SECRET_KEY absente et dossier non inscriptible : clé temporaire (sessions perdues au redémarrage).")
        return secrets.token_hex(32)


def create_app(background: bool = False) -> Flask:
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=_secret_key(),
        MAX_CONTENT_LENGTH=Config.MAX_CONTENT_LENGTH,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=Config.SESSION_COOKIE_SECURE,
        PERMANENT_SESSION_LIFETIME=timedelta(days=Config.SESSION_DAYS),
    )
    if Config.TRUST_PROXY:  # derrière le proxy de l'hébergeur : vraie IP cliente et schéma https
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    db.init_db()

    window = Config.LOGIN_WINDOW_MINUTES * 60
    login_throttle = auth.Throttle(Config.LOGIN_MAX_FAILURES, window)       # identifiant + IP
    ip_throttle = auth.Throttle(Config.LOGIN_MAX_FAILURES * 4, window)      # IP seule
    register_throttle = auth.Throttle(10, 3600)
    user_locks: dict[int, threading.Lock] = defaultdict(threading.Lock)

    # ------------------------------------------------------------ garde-fous communs
    def render_home(mode: str, error: str | None = None, status: int = 200):
        return render_template("home.html", mode=mode, error=error, csrf=auth.csrf_token(),
                               registration_open=Config.ALLOW_REGISTRATION,
                               invite_required=bool(Config.INVITE_CODE)), status

    @app.before_request
    def guard():
        if request.endpoint == "static":
            return None
        g.user = None
        if session.get("uid"):
            g.user = db.get_user(session["uid"])
            if not g.user:
                session.clear()
        if request.method not in ("GET", "HEAD", "OPTIONS") and not auth.csrf_valid():
            if request.path in ("/login", "/register"):
                return render_home("register" if request.path == "/register" else "login",
                                   "Session expirée : réessayez.", 403)
            return jsonify(error="Jeton CSRF invalide : rechargez la page."), 403
        if request.path.startswith("/api/") and not g.user:
            return jsonify(error="Non connecté."), 401
        return None

    @app.after_request
    def headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cache-Control"] = "no-store"
        if Config.SESSION_COOKIE_SECURE:
            resp.headers["Strict-Transport-Security"] = "max-age=31536000"
        return resp

    @app.errorhandler(413)
    def too_big(_):
        return jsonify(error="Fichier trop volumineux (max 5 Mo)."), 413

    def err(msg, code=400):
        return jsonify(error=msg), code

    def start_session(user_id: int):
        session.clear()               # évite la fixation de session
        session["uid"] = user_id
        session.permanent = True

    # ------------------------------------------------------------ pages d'accès
    @app.get("/healthz")
    def healthz():
        return jsonify(ok=True)

    @app.get("/")
    def index():
        if g.user:
            return render_template("index.html", username=g.user["username"], csrf=auth.csrf_token())
        return render_home("login")

    @app.get("/login")
    def login_page():
        return redirect("/") if g.user else render_home("login")

    @app.get("/register")
    def register_page():
        if g.user:
            return redirect("/")
        if not Config.ALLOW_REGISTRATION:
            return render_home("login", "Les inscriptions sont fermées.", 403)
        return render_home("register")

    @app.post("/login")
    def login():
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        ip = request.remote_addr or "?"
        k_user, k_ip = f"{ip}:{username.casefold()}", ip
        if login_throttle.blocked(k_user) or ip_throttle.blocked(k_ip):
            return render_home("login", "Trop de tentatives. Réessayez dans quelques minutes.", 429)
        user = db.get_user_by_name(username)
        if not auth.verify_password(user, password):
            login_throttle.record(k_user)
            ip_throttle.record(k_ip)
            return render_home("login", "Identifiant ou mot de passe incorrect.", 401)
        login_throttle.reset(k_user)
        start_session(user["id"])
        return redirect("/")

    @app.post("/register")
    def register():
        if not Config.ALLOW_REGISTRATION:
            return render_home("login", "Les inscriptions sont fermées.", 403)
        ip = request.remote_addr or "?"
        if register_throttle.blocked(ip):
            return render_home("register", "Trop d'inscriptions depuis cette adresse. Réessayez plus tard.", 429)
        register_throttle.record(ip)
        if Config.INVITE_CODE and not secrets.compare_digest(
                request.form.get("invite", "").encode(), Config.INVITE_CODE.encode()):
            return render_home("register", "Code d'invitation incorrect.", 403)
        username = request.form.get("username", "").strip()
        message = auth.validate_credentials(username, request.form.get("password", ""),
                                            request.form.get("confirm", ""))
        if message:
            return render_home("register", message, 400)
        user_id = db.create_user(username, auth.hash_password(request.form["password"]))
        if user_id is None:
            return render_home("register", "Cet identifiant est déjà pris.", 409)
        start_session(user_id)
        return redirect("/")

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect("/")

    # ------------------------------------------------------------ calcul du planning
    def pcfg() -> planner.PlannerConfig:
        return planner.PlannerConfig(
            day_start=Config.DAY_START, day_end=Config.DAY_END, preferred_start=Config.PREFERRED_START,
            capacity_minutes=Config.DAILY_CAPACITY_MINUTES, history_days=Config.HISTORY_DAYS,
            group_by=Config.GROUP_BY, extra_cap=Config.EXTRA_CAP_PER_CYCLE)

    def build_plan(uid: int):
        courses = [planner.Course(c["subject"], c["kind"] or "", datetime.fromisoformat(c["start"]),
                                  datetime.fromisoformat(c["end"]), c["room"] or "")
                   for c in db.list_courses(uid)]
        subjects = {s["name"]: planner.SubjectCfg(
            s["name"], s["color"], s["session_minutes"], s["chapters"], s["chapters_per_session"],
            s["intensity"], bool(s["enabled"]), s["backlog"]) for s in db.list_subjects(uid)}
        blocks = [planner.Block(date.fromisoformat(b["day"]), time.fromisoformat(b["start"]),
                                time.fromisoformat(b["end"]), b["label"] or "") for b in db.list_blocks(uid)]
        sessions = planner.plan(courses, subjects, db.session_states(uid), blocks, pcfg())
        return sessions, subjects

    def ser(s: planner.Session, subjects) -> dict:
        cfg = subjects.get(s.subject)
        return {
            "id": s.sid, "subject": s.subject, "color": cfg.color if cfg else "#64748b",
            "day": s.day.isoformat(), "start": s.start.isoformat(timespec="minutes"),
            "end": s.end.isoformat(timespec="minutes"), "minutes": s.minutes,
            "target": s.target_start.isoformat(timespec="minutes"),
            "slot_index": s.slot_index, "slot_count": s.slot_count, "chapters": s.chapters,
            "status": s.status, "done": s.done, "catchup": s.catchup,
            "moved": s.moved, "overloaded": s.overloaded,
            "overdue": s.day < date.today() and s.status == "pending",
        }

    def meta_of(s: planner.Session) -> dict:
        return {"catchup": s.catchup, "subject": s.subject,
                "target_day": s.target_start.date().isoformat(), "idx": s.idx}

    def parse_day(raw, default=None):
        try:
            return date.fromisoformat(raw)
        except (TypeError, ValueError):
            return default

    # ------------------------------------------------------------ synchronisation ICS
    def do_sync(uid: int, data: bytes) -> dict:
        courses = parse_ics(data)
        db.replace_courses(uid, courses)
        db.ensure_subjects(uid, sorted({c["subject"] for c in courses}))
        db.set_setting(uid, "last_sync", datetime.now().isoformat(timespec="seconds"))
        db.set_setting(uid, "last_sync_count", str(len(courses)))
        db.set_setting(uid, "last_error", "")
        return {"count": len(courses), "subjects": len({c["subject"].casefold() for c in courses})}

    def sync_from_url(uid: int, url: str) -> dict:
        with user_locks[uid]:
            try:
                return do_sync(uid, fetch_ics(url))
            except IcsError as exc:
                db.set_setting(uid, "last_error", str(exc))
                raise

    app.sync_from_url = sync_from_url  # utilisé par le thread d'auto-rafraîchissement

    # ------------------------------------------------------------ API
    @app.get("/api/me")
    def me():
        return jsonify(username=g.user["username"])

    @app.post("/api/password")
    def change_password():
        body = request.get_json(silent=True) or {}
        user = db.get_user_by_name(g.user["username"])
        if not auth.verify_password(user, body.get("current", "")):
            return err("Mot de passe actuel incorrect.", 403)
        new = body.get("new", "")
        message = auth.validate_credentials(user["username"], new, new)
        if message:
            return err(message)
        db.set_password(user["id"], auth.hash_password(new))
        return jsonify(ok=True)

    @app.get("/api/settings")
    def get_settings():
        uid = g.user["id"]
        url = db.get_setting(uid, "ics_url")
        masked = ("…" + url[-6:]) if url else ""
        return jsonify(ics_configured=bool(url), ics_url_masked=masked,
                       last_sync=db.get_setting(uid, "last_sync"),
                       last_sync_count=db.get_setting(uid, "last_sync_count"),
                       last_error=db.get_setting(uid, "last_error"),
                       auto_refresh_minutes=Config.AUTO_REFRESH_MINUTES,
                       capacity=Config.DAILY_CAPACITY_MINUTES)

    @app.put("/api/settings")
    def put_settings():
        url = (request.get_json(silent=True) or {}).get("ics_url", "").strip()
        if url:
            if not re.match(r"^(https?|webcal)://", url, re.IGNORECASE):
                return err("L'URL doit commencer par https:// ou webcal://")
            db.set_setting(g.user["id"], "ics_url", url)
        return jsonify(ok=True)

    @app.post("/api/sync")
    def sync():
        uid = g.user["id"]
        body = request.get_json(silent=True) or {}
        url = (body.get("url") or "").strip() or db.get_setting(uid, "ics_url")
        if not url:
            return err("Aucune URL ICS configurée. Saisissez-la ou importez un fichier .ics.")
        try:
            info = sync_from_url(uid, url)
        except IcsError as exc:
            return err(str(exc), 502)
        if body.get("url"):
            db.set_setting(uid, "ics_url", url)
        return jsonify(info)

    @app.post("/api/upload")
    def upload():
        f = request.files.get("file")
        if not f or not f.filename.lower().endswith(".ics"):
            return err("Envoyez un fichier .ics exporté depuis Campass/Geode.")
        uid = g.user["id"]
        with user_locks[uid]:
            try:
                return jsonify(do_sync(uid, f.read()))
            except IcsError as exc:
                return err(str(exc))

    @app.get("/api/week")
    def week():
        uid = g.user["id"]
        monday = parse_day(request.args.get("start"), date.today())
        monday -= timedelta(days=monday.weekday())
        end = monday + timedelta(days=7)
        colors = {s["name"].casefold(): s["color"] for s in db.list_subjects(uid)}
        courses = [dict(c, color=colors.get(c["subject"].casefold(), "#64748b")) for c in
                   db.list_courses(uid, monday.isoformat(), end.isoformat())]
        sessions, subjects = build_plan(uid)
        in_week = [ser(s, subjects) for s in sessions if monday <= s.day < end]
        blocks = [b for b in db.list_blocks(uid) if monday.isoformat() <= b["day"] < end.isoformat()]
        load = planner.daily_load(sessions, Config.DAILY_CAPACITY_MINUTES)
        return jsonify(start=monday.isoformat(), courses=courses, sessions=in_week, blocks=blocks,
                       load={k: v for k, v in load.items() if monday.isoformat() <= k < end.isoformat()},
                       day_start=Config.DAY_START.hour, day_end=Config.DAY_END.hour + 1)

    @app.get("/api/today")
    def today():
        uid = g.user["id"]
        sessions, subjects = build_plan(uid)
        t = date.today()
        todo = [ser(s, subjects) for s in sessions
                if s.day == t or (s.day < t and s.status == "pending")]
        load = planner.daily_load(sessions, Config.DAILY_CAPACITY_MINUTES).get(
            t.isoformat(), {"minutes": 0, "done_minutes": 0, "capacity": Config.DAILY_CAPACITY_MINUTES,
                            "ratio": 0, "level": "ok"})
        upcoming = [ser(s, subjects) for s in sessions if s.day > t and s.status == "pending"][:5]
        return jsonify(date=t.isoformat(), todo=todo, load=load, upcoming=upcoming)

    @app.get("/api/agenda")
    def agenda():
        uid = g.user["id"]
        sessions, subjects = build_plan(uid)
        return jsonify(sessions=[ser(s, subjects) for s in sessions],
                       load=planner.daily_load(sessions, Config.DAILY_CAPACITY_MINUTES))

    @app.patch("/api/sessions/<sid>")
    def patch_session(sid):
        uid = g.user["id"]
        body = request.get_json(silent=True) or {}
        sessions, _ = build_plan(uid)
        s = next((x for x in sessions if x.sid == sid), None)
        if s is None:
            return err("Créneau introuvable (le planning a peut-être changé).", 404)
        out = {"ok": True}
        status = body.get("status")
        if status is None and "done" in body:
            status = "done" if body["done"] else "pending"
        if status is not None:
            if status not in STATUSES:
                return err("Statut invalide.")
            out["backlog"] = db.set_status(uid, sid, meta_of(s), status)
        if body.get("reset"):
            db.set_moved(uid, sid, meta_of(s), None, None)
        elif "day" in body and "start" in body:
            if not parse_day(body["day"]) or not HHMM.match(str(body["start"])):
                return err("Date ou heure invalide.")
            db.set_moved(uid, sid, meta_of(s), body["day"], body["start"])
        return jsonify(out)

    @app.get("/api/subjects")
    def subjects_list():
        out = []
        for s in db.list_subjects(g.user["id"]):
            cfg = planner.SubjectCfg(s["name"], s["color"], s["session_minutes"], s["chapters"],
                                     s["chapters_per_session"], s["intensity"], bool(s["enabled"]), s["backlog"])
            slots, minutes = planner.workload(cfg)
            out.append(dict(s, slots=slots, slot_minutes=minutes, total_minutes=slots * minutes,
                            debt_minutes=s["backlog"] * minutes))
        return jsonify(out)

    @app.put("/api/subjects")
    def subject_update():
        body = request.get_json(silent=True) or {}
        name, fields = body.get("name"), {}
        if not name:
            return err("Nom de matière manquant.")
        try:
            rules = {"session_minutes": (int, 5, 480), "chapters": (int, 1, 60),
                     "chapters_per_session": (int, 1, 30), "intensity": (float, 0.25, 5.0),
                     "backlog": (int, 0, 99)}
            for key, (cast, lo, hi) in rules.items():
                if key in body:
                    v = cast(body[key])
                    if not lo <= v <= hi:
                        return err(f"{key} doit être entre {lo} et {hi}.")
                    fields[key] = v
            if "color" in body:
                if not HEX.match(str(body["color"])):
                    return err("Couleur invalide (#rrggbb).")
                fields["color"] = body["color"]
            if "enabled" in body:
                fields["enabled"] = 1 if body["enabled"] else 0
        except (TypeError, ValueError):
            return err("Valeur numérique invalide.")
        if not db.update_subject(g.user["id"], name, fields):
            return err("Matière introuvable.", 404)
        return jsonify(ok=True)

    @app.get("/api/blocks")
    def blocks_list():
        return jsonify(db.list_blocks(g.user["id"]))

    @app.post("/api/blocks")
    def blocks_add():
        b = request.get_json(silent=True) or {}
        if not parse_day(b.get("day")) or not HHMM.match(str(b.get("start", ""))) \
                or not HHMM.match(str(b.get("end", ""))) or b["end"] <= b["start"]:
            return err("Jour/heures invalides (la fin doit suivre le début).")
        db.add_block(g.user["id"], b["day"], b["start"], b["end"], str(b.get("label", ""))[:80])
        return jsonify(ok=True)

    @app.delete("/api/blocks/<int:block_id>")
    def blocks_delete(block_id):
        db.delete_block(g.user["id"], block_id)
        return jsonify(ok=True)

    if background and Config.AUTO_REFRESH_MINUTES > 0:
        threading.Thread(target=_auto_refresh, args=(app,), daemon=True).start()
    return app


def _auto_refresh(app: Flask) -> None:
    """Resynchronise périodiquement le flux ICS de chaque utilisateur qui en a un."""
    stop = threading.Event()
    while not stop.wait(Config.AUTO_REFRESH_MINUTES * 60):
        for uid, url in db.users_with_ics():
            try:
                app.sync_from_url(uid, url)
            except Exception:  # l'erreur est déjà mémorisée dans les réglages de l'utilisateur
                pass


if __name__ == "__main__":
    create_app(background=True).run(host=Config.HOST, port=Config.PORT,
                                    debug=Config.DEBUG, use_reloader=False)
