"""Persistance SQLite multi-utilisateurs : chaque ligne appartient à un user_id."""
import hashlib
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from config import Config

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid TEXT, subject TEXT NOT NULL, kind TEXT,
  start TEXT NOT NULL, end TEXT NOT NULL, room TEXT, summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_courses_user_start ON courses(user_id, start);
CREATE TABLE IF NOT EXISTS subjects(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  session_minutes INTEGER NOT NULL DEFAULT 60,
  chapters INTEGER NOT NULL DEFAULT 2,
  chapters_per_session INTEGER NOT NULL DEFAULT 2,
  intensity REAL NOT NULL DEFAULT 1.0,
  enabled INTEGER NOT NULL DEFAULT 1,
  backlog INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, name)
);
CREATE TABLE IF NOT EXISTS session_state(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | done | missed
  moved_date TEXT, moved_start TEXT,
  catchup INTEGER NOT NULL DEFAULT 0,            -- créneau de rattrapage (dette)
  subject TEXT, target_day TEXT, idx INTEGER,
  debt_delta INTEGER NOT NULL DEFAULT 0,         -- effet déjà appliqué sur le compteur de retard
  PRIMARY KEY(user_id, sid)
);
CREATE TABLE IF NOT EXISTS blocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, label TEXT
);
CREATE TABLE IF NOT EXISTS settings(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT,
  PRIMARY KEY(user_id, key)
);
"""

PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ea580c", "#7c3aed", "#0891b2",
           "#ca8a04", "#dc2626", "#4f46e5", "#0d9488", "#9333ea", "#65a30d"]


@contextmanager
def connect():
    Config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(Config.DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Crée le schéma. Une base v1 (mono-utilisateur) est sauvegardée puis remplacée."""
    path = Config.DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        probe = sqlite3.connect(path)
        try:
            version = probe.execute("PRAGMA user_version").fetchone()[0]
            has_courses = probe.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='courses'").fetchone()
        finally:
            probe.close()
        if version < SCHEMA_VERSION and has_courses:  # ancienne base sans comptes
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            path.rename(path.with_name(f"{path.name}.bak-v1-{stamp}"))
    with connect() as c:
        c.executescript(SCHEMA)
        c.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def color_for(name: str) -> str:
    return PALETTE[int(hashlib.sha1(name.casefold().encode()).hexdigest(), 16) % len(PALETTE)]


# ---------- utilisateurs ----------
def create_user(username: str, password_hash: str) -> int | None:
    """Retourne l'id créé, ou None si l'identifiant existe déjà."""
    try:
        with connect() as c:
            cur = c.execute("INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
                            (username, password_hash, datetime.now().isoformat(timespec="seconds")))
            return cur.lastrowid
    except sqlite3.IntegrityError:
        return None


def get_user_by_name(username: str) -> dict | None:
    with connect() as c:
        row = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    return dict(row) if row else None


def get_user(user_id: int) -> dict | None:
    with connect() as c:
        row = c.execute("SELECT id, username FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def set_password(user_id: int, password_hash: str) -> None:
    with connect() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash, user_id))


def users_with_ics() -> list[tuple[int, str]]:
    with connect() as c:
        rows = c.execute("SELECT user_id, value FROM settings WHERE key='ics_url' AND value<>''").fetchall()
    return [(r["user_id"], r["value"]) for r in rows]


# ---------- réglages ----------
def get_setting(uid: int, key: str, default: str = "") -> str:
    with connect() as c:
        row = c.execute("SELECT value FROM settings WHERE user_id=? AND key=?", (uid, key)).fetchone()
    return row["value"] if row and row["value"] is not None else default


def set_setting(uid: int, key: str, value: str) -> None:
    with connect() as c:
        c.execute("INSERT INTO settings(user_id,key,value) VALUES(?,?,?) "
                  "ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value", (uid, key, value))


# ---------- cours ----------
def replace_courses(uid: int, courses: list[dict]) -> None:
    with connect() as c:
        c.execute("DELETE FROM courses WHERE user_id=?", (uid,))
        c.executemany(
            "INSERT INTO courses(user_id,uid,subject,kind,start,end,room,summary) "
            "VALUES(:user_id,:uid,:subject,:kind,:start,:end,:room,:summary)",
            [dict(c_, user_id=uid) for c_ in courses])


def list_courses(uid: int, start: str | None = None, end: str | None = None) -> list[dict]:
    q, args = "SELECT * FROM courses WHERE user_id=?", [uid]
    if start and end:
        q += " AND start < ? AND end > ?"
        args += [end, start]
    with connect() as c:
        return [dict(r) for r in c.execute(q + " ORDER BY start", args)]


# ---------- matières ----------
def ensure_subjects(uid: int, names: list[str]) -> None:
    with connect() as c:
        for n in names:
            c.execute("INSERT OR IGNORE INTO subjects(user_id,name,color) VALUES(?,?,?)",
                      (uid, n, color_for(n)))


def list_subjects(uid: int) -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM subjects WHERE user_id=? ORDER BY name COLLATE NOCASE", (uid,))]


def update_subject(uid: int, name: str, fields: dict) -> bool:
    allowed = {"color", "session_minutes", "chapters", "chapters_per_session",
               "intensity", "enabled", "backlog"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return False
    with connect() as c:
        cur = c.execute(f"UPDATE subjects SET {', '.join(k + '=?' for k in sets)} "
                        "WHERE user_id=? AND name=?", [*sets.values(), uid, name])
        return cur.rowcount > 0


# ---------- état des créneaux ----------
def session_states(uid: int) -> dict[str, dict]:
    with connect() as c:
        return {r["sid"]: dict(r) for r in c.execute(
            "SELECT * FROM session_state WHERE user_id=?", (uid,))}


def _ensure_state(c, uid: int, sid: str, meta: dict) -> None:
    c.execute("INSERT OR IGNORE INTO session_state(user_id,sid) VALUES(?,?)", (uid, sid))
    c.execute("UPDATE session_state SET catchup=?, subject=?, target_day=?, idx=? "
              "WHERE user_id=? AND sid=?",
              (1 if meta["catchup"] else 0, meta["subject"], meta["target_day"], meta["idx"], uid, sid))


def set_status(uid: int, sid: str, meta: dict, new_status: str) -> int:
    """Change le statut d'un créneau et met à jour le compteur de retard de la matière.

    - base « Non fait »          -> +1 au retard (le travail est reporté au cycle suivant)
    - rattrapage « Fait »        -> -1 au retard (la dette est remboursée)
    - tout autre statut          -> aucun effet ; l'effet précédent est annulé (idempotent)
    Retourne le compteur de retard à jour.
    """
    if new_status not in {"pending", "done", "missed"}:
        raise ValueError("statut invalide")
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        _ensure_state(c, uid, sid, meta)
        old = c.execute("SELECT debt_delta FROM session_state WHERE user_id=? AND sid=?",
                        (uid, sid)).fetchone()["debt_delta"]
        new = 1 if (new_status == "missed" and not meta["catchup"]) else \
            -1 if (new_status == "done" and meta["catchup"]) else 0
        c.execute("UPDATE session_state SET status=?, debt_delta=? WHERE user_id=? AND sid=?",
                  (new_status, new, uid, sid))
        if new != old:
            c.execute("UPDATE subjects SET backlog = MAX(0, backlog + ?) WHERE user_id=? AND name=?",
                      (new - old, uid, meta["subject"]))
        row = c.execute("SELECT backlog FROM subjects WHERE user_id=? AND name=?",
                        (uid, meta["subject"])).fetchone()
        return row["backlog"] if row else 0


def set_moved(uid: int, sid: str, meta: dict, day: str | None, start: str | None) -> None:
    with connect() as c:
        _ensure_state(c, uid, sid, meta)
        c.execute("UPDATE session_state SET moved_date=?, moved_start=? WHERE user_id=? AND sid=?",
                  (day, start, uid, sid))


# ---------- blocages ----------
def list_blocks(uid: int) -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM blocks WHERE user_id=? ORDER BY day,start", (uid,))]


def add_block(uid: int, day: str, start: str, end: str, label: str) -> None:
    with connect() as c:
        c.execute("INSERT INTO blocks(user_id,day,start,end,label) VALUES(?,?,?,?,?)",
                  (uid, day, start, end, label))


def delete_block(uid: int, block_id: int) -> None:
    with connect() as c:
        c.execute("DELETE FROM blocks WHERE id=? AND user_id=?", (block_id, uid))
