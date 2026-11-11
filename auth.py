"""Authentification : hachage des mots de passe, CSRF, limitation des tentatives."""
import hashlib
import hmac
import re
import secrets
import threading
import time
from collections import defaultdict, deque

from flask import request, session
from werkzeug.security import check_password_hash, generate_password_hash

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
MIN_PASSWORD, MAX_PASSWORD = 10, 128

# scrypt si disponible dans cette installation de Python, sinon PBKDF2.
HASH_METHOD = "scrypt" if hasattr(hashlib, "scrypt") else "pbkdf2:sha256"
# Hachage factice : on le vérifie même si l'identifiant n'existe pas, pour ne pas révéler
# par le temps de réponse quels comptes existent.
_DUMMY_HASH = generate_password_hash(secrets.token_hex(16), method=HASH_METHOD)


def hash_password(password: str) -> str:
    return generate_password_hash(password, method=HASH_METHOD)


def verify_password(user: dict | None, password: str) -> bool:
    hashed = user["password_hash"] if user else _DUMMY_HASH
    return check_password_hash(hashed, password) and user is not None


def validate_credentials(username: str, password: str, confirm: str) -> str | None:
    """Retourne un message d'erreur, ou None si tout est valide."""
    if not USERNAME_RE.match(username):
        return "Identifiant : 3 à 32 caractères (lettres, chiffres, . _ -)."
    if len(password) < MIN_PASSWORD:
        return f"Mot de passe : {MIN_PASSWORD} caractères minimum."
    if len(password) > MAX_PASSWORD:
        return f"Mot de passe : {MAX_PASSWORD} caractères maximum."
    if username.casefold() in password.casefold():
        return "Le mot de passe ne doit pas contenir l'identifiant."
    if password != confirm:
        return "Les deux mots de passe ne correspondent pas."
    return None


# ---------------------------------------------------------------- CSRF
def csrf_token() -> str:
    if not session.get("csrf"):
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def csrf_valid() -> bool:
    sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
    expected = session.get("csrf", "")
    return bool(expected) and hmac.compare_digest(sent, expected)


# ---------------------------------------------------------------- limitation des tentatives
class Throttle:
    """Compte des événements dans une fenêtre glissante (en mémoire, par processus)."""

    def __init__(self, limit: int, window_seconds: int):
        self.limit, self.window = limit, window_seconds
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def _purge(self, key: str) -> deque:
        q, now = self._hits[key], time.monotonic()
        while q and now - q[0] > self.window:
            q.popleft()
        return q

    def blocked(self, key: str) -> bool:
        with self._lock:
            return len(self._purge(key)) >= self.limit

    def record(self, key: str) -> None:
        with self._lock:
            self._purge(key).append(time.monotonic())

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)
