"""Moteur de planification des révisions (logique pure, sans accès base : testable).

Règle : pour chaque occurrence d'un cours, on repère la prochaine occurrence (autre jour) de la même
matière et on place la révision la veille (J-1) de cette prochaine occurrence.
Si la matière demande plusieurs créneaux, les suivants remontent vers J-2, J-3... sans jamais
passer avant le cours précédent.
"""
import hashlib
import math
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta


@dataclass
class Course:
    subject: str
    kind: str
    start: datetime
    end: datetime
    room: str = ""


@dataclass
class SubjectCfg:
    name: str
    color: str = "#2563eb"
    session_minutes: int = 60
    chapters: int = 2
    chapters_per_session: int = 2
    intensity: float = 1.0
    enabled: bool = True
    backlog: int = 0            # nombre de cours/révisions en retard (dette)


@dataclass
class PlannerConfig:
    day_start: time = time(8, 0)
    day_end: time = time(21, 0)
    preferred_start: time = time(18, 0)
    capacity_minutes: int = 180
    history_days: int = 7
    group_by: str = "subject"  # "subject" | "subject_kind"
    extra_cap: int = 2         # créneaux de rattrapage maximum ajoutés par cycle


@dataclass
class Block:
    day: date
    start: time
    end: time
    label: str = ""


@dataclass
class Session:
    sid: str
    subject: str
    target_start: datetime      # cours que cette révision prépare
    day: date
    start: datetime
    end: datetime
    minutes: int
    slot_index: int
    slot_count: int
    done: bool = False
    status: str = "pending"     # pending | done | missed
    catchup: bool = False       # créneau de rattrapage généré par la dette
    idx: int = 0                # index dans la série (base ou rattrapage)
    moved: bool = False
    overloaded: bool = False
    chapters: list[int] = field(default_factory=list)


# ------------------------------------------------------------------ charge d'une matière
def workload(cfg: SubjectCfg) -> tuple[int, int]:
    """(nombre de créneaux, durée en minutes de chaque créneau) selon la charge paramétrée."""
    slots = max(1, math.ceil(max(cfg.chapters, 1) / max(cfg.chapters_per_session, 1)))
    minutes = int(round(cfg.session_minutes * max(cfg.intensity, 0.1) / 5) * 5)
    return slots, max(minutes, 5)


def make_sid(subject: str, target_day: date, idx: int, catchup: bool = False) -> str:
    tag = "c" if catchup else "b"   # les rattrapages ont leur propre série d'identifiants
    return hashlib.sha1(f"{tag}|{subject.casefold()}|{target_day.isoformat()}|{idx}".encode()).hexdigest()[:12]


# ------------------------------------------------------------------ occurrences
def _group_key(c: Course, group_by: str) -> str:
    return c.subject.casefold() + (f"|{c.kind.casefold()}" if group_by == "subject_kind" else "")


def consecutive_occurrences(courses: list[Course], group_by: str = "subject"):
    """Couples (occurrence précédente, occurrence suivante) par matière, sur des jours distincts."""
    groups: dict[str, dict[date, Course]] = {}
    for c in sorted(courses, key=lambda c: c.start):
        groups.setdefault(_group_key(c, group_by), {}).setdefault(c.start.date(), c)
    for days in groups.values():
        ordered = [days[d] for d in sorted(days)]
        for prev, nxt in zip(ordered, ordered[1:]):
            yield prev, nxt


# ------------------------------------------------------------------ placement
def _merge(intervals):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def _free_gaps(busy, win_start: datetime, win_end: datetime):
    cursor, gaps = win_start, []
    for s, e in _merge(busy):
        if e <= cursor:
            continue
        if s > cursor:
            gaps.append((cursor, min(s, win_end)))
        cursor = max(cursor, e)
        if cursor >= win_end:
            break
    if cursor < win_end:
        gaps.append((cursor, win_end))
    return [(s, e) for s, e in gaps if e > s]


def find_slot(day: date, minutes: int, busy, cfg: PlannerConfig):
    """Premier créneau libre de `minutes` ; on préfère après `preferred_start`."""
    win_s = datetime.combine(day, cfg.day_start)
    win_e = datetime.combine(day, cfg.day_end)
    pref = max(win_s, datetime.combine(day, cfg.preferred_start))
    need = timedelta(minutes=minutes)
    gaps = _free_gaps(busy, win_s, win_e)
    for s, e in gaps:                       # 1) après l'heure préférée
        start = max(s, pref)
        if e - start >= need:
            return start, start + need, False
    for s, e in gaps:                       # 2) n'importe où dans la journée
        if e - s >= need:
            return s, s + need, False
    start = max(win_s, win_e - need)        # 3) journée saturée : on signale la surcharge
    return start, start + need, True




# ------------------------------------------------------------------ planification complète
def _subject_cfg(subjects: dict[str, SubjectCfg], name: str) -> SubjectCfg:
    return subjects.get(name) or next(
        (v for k, v in subjects.items() if k.casefold() == name.casefold()), None) or SubjectCfg(name)


def plan(courses: list[Course], subjects: dict[str, SubjectCfg], states: dict[str, dict],
         blocks: list[Block], cfg: PlannerConfig, today: date | None = None) -> list[Session]:
    """Génère les créneaux de révision.

    Base : `workload()` créneaux par cycle, à J-1 (puis J-2...) de la prochaine occurrence.
    Rattrapage : le compteur de retard `backlog` de la matière ajoute des créneaux dans les
    prochains cycles (au plus `extra_cap` par cycle). Une session « Non fait » alimente ce compteur
    (voir db.set_status) : son travail est donc reporté au cycle suivant.
    `states` : sid -> {status, moved_date, moved_start, catchup, subject, target_day, idx}.
    """
    today = today or date.today()
    min_day = today - timedelta(days=cfg.history_days)
    busy: dict[date, list] = {}

    def add_busy(day, s, e):
        busy.setdefault(day, []).append((s, e))

    for c in courses:
        add_busy(c.start.date(), c.start, c.end)
    for b in blocks:
        add_busy(b.day, datetime.combine(b.day, b.start), datetime.combine(b.day, b.end))

    # 1) Créneaux souhaités, matière par matière
    by_subject: dict[str, list] = {}
    for prev, nxt in consecutive_occurrences(courses, cfg.group_by):
        by_subject.setdefault(nxt.subject.casefold(), []).append((prev, nxt))

    wanted: list[Session] = []

    def make(scfg, nxt, day, idx, minutes, slots, catchup, chapters=()):
        target_day = nxt.start.date()
        origin = datetime.combine(day, cfg.day_start)
        return Session(make_sid(nxt.subject, target_day, idx, catchup), scfg.name, nxt.start, day,
                       origin, origin + timedelta(minutes=minutes), minutes, idx, slots,
                       catchup=catchup, idx=idx, chapters=list(chapters))

    for key, items in by_subject.items():
        items.sort(key=lambda pn: pn[1].start)
        scfg = _subject_cfg(subjects, items[0][1].subject)
        if not scfg.enabled:
            continue
        slots, minutes = workload(scfg)
        remaining = max(0, scfg.backlog)
        for prev, nxt in items:
            target_day = nxt.start.date()
            floor_day = prev.start.date()
            # -- créneaux de base
            per = math.ceil(max(scfg.chapters, 1) / slots)
            for i in range(slots):
                day = max(target_day - timedelta(days=1 + i), floor_day)
                if day < min_day:
                    continue
                first = i * per + 1
                chapters = range(first, min(first + per - 1, max(scfg.chapters, 1)) + 1)
                wanted.append(make(scfg, nxt, day, i, minutes, slots, False, chapters))
            # -- rattrapages : ceux déjà connus (historique / déplacés) + ceux dus à la dette
            retained = {st["idx"]: sid for sid, st in states.items()
                        if st.get("catchup") and (st.get("subject") or "").casefold() == key
                        and st.get("target_day") == target_day.isoformat() and st.get("idx") is not None}
            pending_retained = sum(1 for sid in retained.values()
                                   if (states[sid].get("status") or "pending") == "pending")
            new = 0
            # Un rattrapage n'est jamais placé aujourd'hui : il part dans un cycle dont la
            # fenêtre de révision (J-1 du cours) commence demain ou plus tard.
            if target_day >= today + timedelta(days=2):
                want = min(cfg.extra_cap, remaining)
                new = max(0, want - pending_retained)
                remaining = max(0, remaining - max(want, pending_retained))
            catch_floor = max(floor_day, today + timedelta(days=1))
            indices = sorted(retained)
            used, n = set(indices), 0
            j = 0
            while n < new:
                if j not in used:
                    indices.append(j)
                    used.add(j)
                    n += 1
                j += 1
            for j in indices:
                # un rattrapage déjà vécu garde sa place ; les nouveaux ne partent pas dans le passé
                lower = floor_day if j in retained else catch_floor
                day = max(target_day - timedelta(days=1 + slots + j), lower)
                if day < min_day:
                    continue
                wanted.append(make(scfg, nxt, day, j, minutes, 0, True))

    # 2) Créneaux déplacés par l'utilisateur : prioritaires
    final, auto = [], []
    for s in wanted:
        st = states.get(s.sid, {})
        s.status = st.get("status") or "pending"
        s.done = s.status == "done"
        if st.get("moved_date") and st.get("moved_start"):
            h, m = map(int, st["moved_start"].split(":"))
            s.day = date.fromisoformat(st["moved_date"])
            s.start = datetime.combine(s.day, time(h, m))
            s.end = s.start + timedelta(minutes=s.minutes)
            s.moved = True
            if s.status != "missed":      # un « Non fait » libère sa plage
                add_busy(s.day, s.start, s.end)
            final.append(s)
        else:
            auto.append(s)

    # 3) Placement automatique des autres, dans l'ordre chronologique
    for s in sorted(auto, key=lambda s: (s.day, s.target_start, s.catchup, s.idx)):
        s.start, s.end, s.overloaded = find_slot(s.day, s.minutes, busy.get(s.day, []), cfg)
        if s.status != "missed":
            add_busy(s.day, s.start, s.end)
        final.append(s)

    # 4) Chevauchements pour les créneaux déplacés à la main
    live = [s for s in final if s.status != "missed"]
    for s in live:
        if s.moved:
            s.overloaded = any(o is not s and o.day == s.day and o.start < s.end and s.start < o.end
                               for o in live) or any(
                c.start.date() == s.day and c.start < s.end and s.start < c.end for c in courses)
    return sorted(final, key=lambda s: s.start)


def daily_load(sessions: list[Session], capacity: int) -> dict[str, dict]:
    """Minutes de révision par jour (hors « Non fait ») + niveau par rapport à la capacité."""
    out: dict[str, dict] = {}
    for s in sessions:
        if s.status == "missed":
            continue
        d = out.setdefault(s.day.isoformat(), {"minutes": 0, "done_minutes": 0})
        d["minutes"] += s.minutes
        if s.done:
            d["done_minutes"] += s.minutes
    for d in out.values():
        ratio = d["minutes"] / capacity if capacity else 0
        d.update(capacity=capacity, ratio=round(ratio, 2),
                 level="over" if ratio > 1 else "warn" if ratio > 0.75 else "ok")
    return out
