"""Application Flask : API JSON + interface (templates/index.html)."""
import re
import threading
from datetime import date, datetime, time, timedelta

from flask import Flask, jsonify, render_template, request

import db
import planner
from config import Config
from ics_service import IcsError, fetch_ics, parse_ics

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
sync_lock = threading.Lock()


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = Config.MAX_CONTENT_LENGTH
    db.init_db()

    # ------------------------------------------------------------ sécurité
    @app.before_request
    def csrf_guard():
        # Les navigateurs n'ajoutent pas cet en-tête sur un formulaire cross-site : bloque le CSRF.
        if request.method not in ("GET", "HEAD", "OPTIONS") and \
                request.headers.get("X-Requested-With") != "fetch":
            return jsonify(error="En-tête X-Requested-With manquant."), 403

    @app.after_request
    def headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.errorhandler(413)
    def too_big(_):
        return jsonify(error="Fichier trop volumineux (max 5 Mo)."), 413

    # ------------------------------------------------------------ helpers
    def err(msg, code=400):
        return jsonify(error=msg), code

    def pcfg() -> planner.PlannerConfig:
        return planner.PlannerConfig(
            day_start=Config.DAY_START, day_end=Config.DAY_END, preferred_start=Config.PREFERRED_START,
            capacity_minutes=Config.DAILY_CAPACITY_MINUTES, history_days=Config.HISTORY_DAYS,
            group_by=Config.GROUP_BY)

    def build_plan():
        courses = [planner.Course(c["subject"], c["kind"] or "", datetime.fromisoformat(c["start"]),
                                  datetime.fromisoformat(c["end"]), c["room"] or "")
                   for c in db.list_courses()]
        subjects = {s["name"]: planner.SubjectCfg(
            s["name"], s["color"], s["session_minutes"], s["chapters"], s["chapters_per_session"],
            s["intensity"], bool(s["enabled"])) for s in db.list_subjects()}
        blocks = [planner.Block(date.fromisoformat(b["day"]), time.fromisoformat(b["start"]),
                                time.fromisoformat(b["end"]), b["label"] or "") for b in db.list_blocks()]
        sessions = planner.plan(courses, subjects, db.session_states(), blocks, pcfg())
        return sessions, subjects

    def ser(s: planner.Session, subjects) -> dict:
        today = date.today()
        cfg = subjects.get(s.subject)
        return {
            "id": s.sid, "subject": s.subject, "color": cfg.color if cfg else "#64748b",
            "day": s.day.isoformat(), "start": s.start.isoformat(timespec="minutes"),
            "end": s.end.isoformat(timespec="minutes"), "minutes": s.minutes,
            "target": s.target_start.isoformat(timespec="minutes"),
            "slot_index": s.slot_index, "slot_count": s.slot_count, "chapters": s.chapters,
            "done": s.done, "moved": s.moved, "overloaded": s.overloaded,
            "overdue": s.day < today and not s.done,
        }

    def color_map():
        return {s["name"]: s["color"] for s in db.list_subjects()}

    def parse_day(raw, default=None):
        try:
            return date.fromisoformat(raw)
        except (TypeError, ValueError):
            return default

    # ------------------------------------------------------------ synchronisation
    def do_sync(data: bytes) -> dict:
        courses = parse_ics(data)
        db.replace_courses(courses)
        db.ensure_subjects(sorted({c["subject"] for c in courses}))
        info = {"count": len(courses), "subjects": len({c["subject"].casefold() for c in courses})}
        db.set_setting("last_sync", datetime.now().isoformat(timespec="seconds"))
        db.set_setting("last_sync_count", str(info["count"]))
        db.set_setting("last_error", "")
        return info

    def sync_from_url(url: str) -> dict:
        with sync_lock:
            try:
                return do_sync(fetch_ics(url))
            except IcsError as exc:
                db.set_setting("last_error", str(exc))
                raise

    app.sync_from_url = sync_from_url  # utilisé par le thread d'auto-rafraîchissement

    def current_url() -> str:
        return db.get_setting("ics_url") or Config.ICS_URL

    # ------------------------------------------------------------ pages & API
    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/settings")
    def get_settings():
        url = current_url()
        masked = (url[:url.find("/", 8) + 1] + "…" + url[-6:]) if len(url) > 20 and url.find("/", 8) > 0 else (
            "…" + url[-6:] if url else "")
        return jsonify(ics_configured=bool(url), ics_url_masked=masked,
                       last_sync=db.get_setting("last_sync"), last_sync_count=db.get_setting("last_sync_count"),
                       last_error=db.get_setting("last_error"),
                       auto_refresh_minutes=Config.AUTO_REFRESH_MINUTES,
                       capacity=Config.DAILY_CAPACITY_MINUTES,
                       day_start=Config.DAY_START.strftime("%H:%M"), day_end=Config.DAY_END.strftime("%H:%M"))

    @app.put("/api/settings")
    def put_settings():
        url = (request.get_json(silent=True) or {}).get("ics_url", "").strip()
        if url:
            if not re.match(r"^(https?|webcal)://", url, re.IGNORECASE):
                return err("L'URL doit commencer par https:// ou webcal://")
            db.set_setting("ics_url", url)
        return jsonify(ok=True)

    @app.post("/api/sync")
    def sync():
        body = request.get_json(silent=True) or {}
        url = (body.get("url") or "").strip() or current_url()
        if not url:
            return err("Aucune URL ICS configurée. Saisissez-la ou uploadez un fichier .ics.")
        try:
            info = sync_from_url(url)
        except IcsError as exc:
            return err(str(exc), 502)
        if body.get("url"):
            db.set_setting("ics_url", url)
        return jsonify(info)

    @app.post("/api/upload")
    def upload():
        f = request.files.get("file")
        if not f or not f.filename.lower().endswith(".ics"):
            return err("Envoyez un fichier .ics exporté depuis Campass.")
        with sync_lock:
            try:
                return jsonify(do_sync(f.read()))
            except IcsError as exc:
                return err(str(exc))

    @app.get("/api/week")
    def week():
        monday = parse_day(request.args.get("start"), date.today())
        monday -= timedelta(days=monday.weekday())
        end = monday + timedelta(days=7)
        colors = color_map()
        courses = [dict(c, color=colors.get(c["subject"], "#64748b")) for c in
                   db.list_courses(monday.isoformat(), end.isoformat())]
        sessions, subjects = build_plan()
        in_week = [ser(s, subjects) for s in sessions if monday <= s.day < end]
        blocks = [b for b in db.list_blocks() if monday.isoformat() <= b["day"] < end.isoformat()]
        load = planner.daily_load(sessions, Config.DAILY_CAPACITY_MINUTES)
        return jsonify(start=monday.isoformat(), courses=courses, sessions=in_week, blocks=blocks,
                       load={k: v for k, v in load.items() if monday.isoformat() <= k < end.isoformat()},
                       day_start=Config.DAY_START.hour, day_end=Config.DAY_END.hour + 1)

    @app.get("/api/today")
    def today():
        sessions, subjects = build_plan()
        t = date.today()
        todo = [ser(s, subjects) for s in sessions if s.day == t or (s.day < t and not s.done)]
        load = planner.daily_load(sessions, Config.DAILY_CAPACITY_MINUTES).get(
            t.isoformat(), {"minutes": 0, "done_minutes": 0, "capacity": Config.DAILY_CAPACITY_MINUTES,
                            "ratio": 0, "level": "ok"})
        nxt = [ser(s, subjects) for s in sessions if s.day > t and not s.done][:5]
        return jsonify(date=t.isoformat(), todo=todo, load=load, upcoming=nxt)

    @app.get("/api/agenda")
    def agenda():
        sessions, subjects = build_plan()
        load = planner.daily_load(sessions, Config.DAILY_CAPACITY_MINUTES)
        return jsonify(sessions=[ser(s, subjects) for s in sessions], load=load)

    @app.patch("/api/sessions/<sid>")
    def patch_session(sid):
        body = request.get_json(silent=True) or {}
        sessions, _ = build_plan()
        if sid not in {s.sid for s in sessions}:
            return err("Créneau introuvable (le planning a peut-être changé).", 404)
        if "done" in body:
            db.set_session_state(sid, done=1 if body["done"] else 0)
        if body.get("reset"):
            db.set_session_state(sid, moved_date=None, moved_start=None)
        elif "day" in body and "start" in body:
            if not parse_day(body["day"]) or not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", str(body["start"])):
                return err("Date ou heure invalide.")
            db.set_session_state(sid, moved_date=body["day"], moved_start=body["start"])
        return jsonify(ok=True)

    @app.get("/api/subjects")
    def subjects_list():
        out = []
        for s in db.list_subjects():
            cfg = planner.SubjectCfg(s["name"], s["color"], s["session_minutes"], s["chapters"],
                                     s["chapters_per_session"], s["intensity"], bool(s["enabled"]))
            slots, minutes = planner.workload(cfg)
            out.append(dict(s, slots=slots, slot_minutes=minutes, total_minutes=slots * minutes))
        return jsonify(out)

    @app.put("/api/subjects")
    def subject_update():
        body = request.get_json(silent=True) or {}
        name, fields = body.get("name"), {}
        if not name:
            return err("Nom de matière manquant.")
        try:
            rules = {"session_minutes": (int, 5, 480), "chapters": (int, 1, 60),
                     "chapters_per_session": (int, 1, 30), "intensity": (float, 0.25, 5.0)}
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
        if not db.update_subject(name, fields):
            return err("Matière introuvable.", 404)
        return jsonify(ok=True)

    @app.get("/api/blocks")
    def blocks_list():
        return jsonify(db.list_blocks())

    @app.post("/api/blocks")
    def blocks_add():
        b = request.get_json(silent=True) or {}
        t = r"^([01]\d|2[0-3]):[0-5]\d$"
        if not parse_day(b.get("day")) or not re.match(t, str(b.get("start", ""))) \
                or not re.match(t, str(b.get("end", ""))) or b["end"] <= b["start"]:
            return err("Jour/heures invalides (la fin doit suivre le début).")
        db.add_block(b["day"], b["start"], b["end"], str(b.get("label", ""))[:80])
        return jsonify(ok=True)

    @app.delete("/api/blocks/<int:block_id>")
    def blocks_delete(block_id):
        db.delete_block(block_id)
        return jsonify(ok=True)

    return app


def _auto_refresh(app: Flask) -> None:
    stop = threading.Event()
    while not stop.wait(Config.AUTO_REFRESH_MINUTES * 60):
        url = db.get_setting("ics_url") or Config.ICS_URL
        if url:
            try:
                app.sync_from_url(url)
            except Exception:  # l'erreur est déjà mémorisée dans les réglages
                pass


if __name__ == "__main__":
    application = create_app()
    if Config.AUTO_REFRESH_MINUTES > 0:
        threading.Thread(target=_auto_refresh, args=(application,), daemon=True).start()
    application.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG, use_reloader=False)
