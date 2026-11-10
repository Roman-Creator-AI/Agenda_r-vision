"""Persistance SQLite (cours importés, matières, état des créneaux, blocages, réglages)."""
import hashlib
import sqlite3
from contextlib import contextmanager

from config import Config

SCHEMA = """
CREATE TABLE IF NOT EXISTS courses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT, subject TEXT NOT NULL, kind TEXT,
  start TEXT NOT NULL, end TEXT NOT NULL, room TEXT, summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_courses_start ON courses(start);
CREATE TABLE IF NOT EXISTS subjects(
  name TEXT PRIMARY KEY, color TEXT NOT NULL,
  session_minutes INTEGER NOT NULL DEFAULT 60,
  chapters INTEGER NOT NULL DEFAULT 2,
  chapters_per_session INTEGER NOT NULL DEFAULT 2,
  intensity REAL NOT NULL DEFAULT 1.0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS session_state(
  sid TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0,
  moved_date TEXT, moved_start TEXT
);
CREATE TABLE IF NOT EXISTS blocks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, label TEXT
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
"""

PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ea580c", "#7c3aed", "#0891b2",
           "#ca8a04", "#dc2626", "#4f46e5", "#0d9488", "#9333ea", "#65a30d"]


@contextmanager
def connect():
    Config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(Config.DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as c:
        c.executescript(SCHEMA)


def color_for(name: str) -> str:
    return PALETTE[int(hashlib.sha1(name.casefold().encode()).hexdigest(), 16) % len(PALETTE)]


# ---------- réglages ----------
def get_setting(key: str, default: str = "") -> str:
    with connect() as c:
        row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row and row["value"] is not None else default


def set_setting(key: str, value: str) -> None:
    with connect() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


# ---------- cours ----------
def replace_courses(courses: list[dict]) -> None:
    with connect() as c:
        c.execute("DELETE FROM courses")
        c.executemany(
            "INSERT INTO courses(uid,subject,kind,start,end,room,summary) "
            "VALUES(:uid,:subject,:kind,:start,:end,:room,:summary)", courses)


def list_courses(start: str | None = None, end: str | None = None) -> list[dict]:
    q, args = "SELECT * FROM courses", []
    if start and end:
        q += " WHERE start < ? AND end > ?"
        args = [end, start]
    with connect() as c:
        return [dict(r) for r in c.execute(q + " ORDER BY start", args)]


# ---------- matières ----------
def ensure_subjects(names: list[str]) -> None:
    with connect() as c:
        known = {r["name"].casefold() for r in c.execute("SELECT name FROM subjects")}
        for n in names:
            if n.casefold() not in known:
                c.execute("INSERT INTO subjects(name,color) VALUES(?,?)", (n, color_for(n)))
                known.add(n.casefold())


def list_subjects() -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute("SELECT * FROM subjects ORDER BY name COLLATE NOCASE")]


def update_subject(name: str, fields: dict) -> bool:
    allowed = {"color", "session_minutes", "chapters", "chapters_per_session", "intensity", "enabled"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return False
    with connect() as c:
        cur = c.execute(f"UPDATE subjects SET {', '.join(k + '=?' for k in sets)} WHERE name=?",
                        [*sets.values(), name])
        return cur.rowcount > 0


# ---------- état des créneaux ----------
def session_states() -> dict[str, dict]:
    with connect() as c:
        return {r["sid"]: dict(r) for r in c.execute("SELECT * FROM session_state")}


def set_session_state(sid: str, **fields) -> None:
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO session_state(sid) VALUES(?)", (sid,))
        for k in ("done", "moved_date", "moved_start"):
            if k in fields:
                c.execute(f"UPDATE session_state SET {k}=? WHERE sid=?", (fields[k], sid))


# ---------- blocages ----------
def list_blocks() -> list[dict]:
    with connect() as c:
        return [dict(r) for r in c.execute("SELECT * FROM blocks ORDER BY day,start")]


def add_block(day: str, start: str, end: str, label: str) -> None:
    with connect() as c:
        c.execute("INSERT INTO blocks(day,start,end,label) VALUES(?,?,?,?)", (day, start, end, label))


def delete_block(block_id: int) -> None:
    with connect() as c:
        c.execute("DELETE FROM blocks WHERE id=?", (block_id,))
