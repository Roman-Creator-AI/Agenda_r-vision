"""Configuration centralisée : tout vient de l'environnement (.env)."""
import os
from datetime import time
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in {"1", "true", "yes", "on"}


def _time(name: str, default: str) -> time:
    raw = os.getenv(name, default).strip()
    try:
        h, m = raw.split(":")
        return time(int(h), int(m))
    except ValueError:
        h, m = default.split(":")
        return time(int(h), int(m))


class Config:
    # Serveur
    HOST = os.getenv("HOST", "127.0.0.1")
    PORT = _int("PORT", 5000)
    DEBUG = _bool("FLASK_DEBUG", False)
    MAX_CONTENT_LENGTH = 5 * 1024 * 1024  # taille max d'un .ics uploadé / téléchargé

    # Données
    DB_PATH = Path(os.getenv("DB_PATH", "data/revisions.db"))
    if not DB_PATH.is_absolute():
        DB_PATH = BASE_DIR / DB_PATH

    # Calendrier
    ICS_URL = os.getenv("ICS_URL", "").strip()
    TIMEZONE = os.getenv("TIMEZONE", "Europe/Paris")
    AUTO_REFRESH_MINUTES = _int("AUTO_REFRESH_MINUTES", 60)
    SYNC_PAST_DAYS = _int("SYNC_PAST_DAYS", 30)
    SYNC_FUTURE_DAYS = _int("SYNC_FUTURE_DAYS", 150)
    GROUP_BY = os.getenv("GROUP_BY", "subject")  # "subject" | "subject_kind"
    SUMMARY_REGEX = os.getenv("SUMMARY_REGEX", "").strip()
    IGNORE_REGEX = os.getenv("IGNORE_REGEX", "(férié|vacances|fermeture)").strip()

    # Planification
    DAY_START = _time("DAY_START", "08:00")
    DAY_END = _time("DAY_END", "21:00")
    PREFERRED_START = _time("PREFERRED_START", "18:00")
    DAILY_CAPACITY_MINUTES = _int("DAILY_CAPACITY_MINUTES", 180)
    HISTORY_DAYS = _int("HISTORY_DAYS", 7)

    # Sécurité
    ALLOW_PRIVATE_ICS_HOSTS = _bool("ALLOW_PRIVATE_ICS_HOSTS", False)
