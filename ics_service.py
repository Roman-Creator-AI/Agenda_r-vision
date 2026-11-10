"""Lecture et analyse d'un flux ICS (URL d'abonnement ou fichier .ics exporté de Campass)."""
import ipaddress
import re
import socket
from datetime import date, datetime, timedelta
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events
import requests

from config import Config

MAX_BYTES = Config.MAX_CONTENT_LENGTH
MAX_REDIRECTS = 3

KIND_PATTERNS = [
    ("CM", r"\b(CM|cours magistral|amphi)\b"),
    ("TD", r"\b(TD|travaux dirig[ée]s?)\b"),
    ("TP", r"\b(TP|travaux pratiques?)\b"),
    ("Examen", r"\b(DS|examen|partiel|contr[oô]le|CC)\b"),
    ("Projet", r"\bprojet\b"),
    ("Cours", r"\bcours\b"),
]


class IcsError(Exception):
    """Erreur lisible par l'utilisateur."""


# ---------------------------------------------------------------- téléchargement
def _check_host(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise IcsError("URL invalide (http/https/webcal uniquement).")
    if Config.ALLOW_PRIVATE_ICS_HOSTS:
        return
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise IcsError(f"Hôte introuvable : {parsed.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise IcsError("URL refusée : adresse privée ou locale (protection SSRF).")


def fetch_ics(url: str) -> bytes:
    """Télécharge le flux ICS (taille limitée, redirections revalidées)."""
    url = url.strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    for _ in range(MAX_REDIRECTS + 1):
        _check_host(url)
        try:
            resp = requests.get(url, timeout=15, stream=True, allow_redirects=False,
                                headers={"User-Agent": "campass-revisions/1.0"})
        except requests.RequestException as exc:
            raise IcsError(f"Téléchargement impossible : {exc.__class__.__name__}") from exc
        if resp.is_redirect:
            url = urljoin(url, resp.headers.get("Location", ""))
            continue
        if resp.status_code != 200:
            raise IcsError(f"Le serveur a répondu {resp.status_code}.")
        data = b""
        for chunk in resp.iter_content(65536):
            data += chunk
            if len(data) > MAX_BYTES:
                raise IcsError("Fichier ICS trop volumineux (> 5 Mo).")
        return data
    raise IcsError("Trop de redirections.")


# ---------------------------------------------------------------- analyse du titre
def parse_summary(summary: str, description: str = "") -> tuple[str, str]:
    """Retourne (matière, type). Adaptable via SUMMARY_REGEX (groupes nommés subject/kind)."""
    summary = " ".join((summary or "").split())
    if Config.SUMMARY_REGEX:
        m = re.search(Config.SUMMARY_REGEX, summary, re.IGNORECASE)
        if m and m.groupdict().get("subject"):
            return (" ".join(m.group("subject").split()),
                    (m.groupdict().get("kind") or "Cours").strip().upper())
    kind = "Cours"
    subject = summary
    for label, pattern in KIND_PATTERNS:
        if re.search(pattern, summary, re.IGNORECASE):
            kind = label
            subject = re.sub(pattern, " ", summary, count=1, flags=re.IGNORECASE)
            break
    subject = re.sub(r"[\[\]()]", " ", subject)
    subject = re.sub(r"^[\s\-–:|/,]+|[\s\-–:|/,]+$", "", subject)
    subject = " ".join(subject.split())
    return (subject or summary or "Sans titre"), kind


def _to_local(value, tz: ZoneInfo) -> datetime | None:
    if isinstance(value, datetime):
        if value.tzinfo:
            return value.astimezone(tz).replace(tzinfo=None)
        return value
    return None  # événement "toute la journée" : ignoré


# ---------------------------------------------------------------- analyse du flux
def parse_ics(data: bytes, start: date | None = None, end: date | None = None) -> list[dict]:
    """Extrait les cours (récurrences développées) entre start et end."""
    today = date.today()
    start = start or today - timedelta(days=Config.SYNC_PAST_DAYS)
    end = end or today + timedelta(days=Config.SYNC_FUTURE_DAYS)
    tz = ZoneInfo(Config.TIMEZONE)
    try:
        cal = icalendar.Calendar.from_ical(data)
    except Exception as exc:  # icalendar lève des erreurs variées
        raise IcsError("Fichier ICS illisible.") from exc

    ignore = re.compile(Config.IGNORE_REGEX, re.IGNORECASE) if Config.IGNORE_REGEX else None
    events = recurring_ical_events.of(cal).between(start, end)

    out, seen = [], set()
    for ev in events:
        if ev.name != "VEVENT":
            continue
        summary = str(ev.get("SUMMARY", "")).strip()
        if ignore and ignore.search(summary):
            continue
        begin = _to_local(ev.decoded("DTSTART"), tz)
        if begin is None:
            continue
        if ev.get("DTEND") is not None:
            finish = _to_local(ev.decoded("DTEND"), tz)
        elif ev.get("DURATION") is not None:
            finish = begin + ev.decoded("DURATION")
        else:
            finish = begin + timedelta(hours=1)
        if finish is None or finish <= begin:
            finish = begin + timedelta(hours=1)
        subject, kind = parse_summary(summary, str(ev.get("DESCRIPTION", "")))
        key = (subject.casefold(), kind, begin)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "uid": str(ev.get("UID", "")),
            "subject": subject, "kind": kind,
            "start": begin.isoformat(timespec="minutes"),
            "end": finish.isoformat(timespec="minutes"),
            "room": str(ev.get("LOCATION", "")).strip(),
            "summary": summary,
        })
    out.sort(key=lambda c: c["start"])
    return out
