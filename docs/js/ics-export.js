// Export du planning de révision au format iCalendar (.ics) : on l'ouvre dans le calendrier du téléphone ou de l'ordinateur.
// Heures « flottantes » (sans fuseau) : l'événement reste à 18h00 heure locale, où que tu sois.
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const local = dt => `${dt.slice(0, 4)}${dt.slice(5, 7)}${dt.slice(8, 10)}T${dt.slice(11, 13)}${dt.slice(14, 16)}00`;
const utc = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Coupe les lignes de plus de 75 octets (RFC 5545), sans couper un caractère UTF-8 en deux. */
function fold(line) {
  const enc = new TextEncoder(), out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const fmtDay = d => new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * `sessions` : créneaux de /api/agenda. Seuls les créneaux à faire, à partir d'aujourd'hui, sont exportés.
 * `alarmMinutes` : alerte avant le début (0 = aucune).
 */
export function buildIcs(sessions, { today, now = new Date(), alarmMinutes = 30, calendarName = 'Révisions Campass' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Révisions Campass//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
                 `X-WR-CALNAME:${esc(calendarName)}`];
  const stamp = utc(now);
  let count = 0;
  for (const s of sessions) {
    if (s.status !== 'pending' || s.day < today) continue;
    count++;
    const chap = s.chapters && s.chapters.length ? ` · chapitres ${s.chapters[0]}${s.chapters.length > 1 ? '–' + s.chapters[s.chapters.length - 1] : ''}` : '';
    lines.push('BEGIN:VEVENT', `UID:${s.id}@revisions-campass`, `DTSTAMP:${stamp}`,
      `DTSTART:${local(s.start)}`, `DTEND:${local(s.end)}`,
      `SUMMARY:${esc(`${s.catchup ? '↻' : '✎'} Révision : ${s.subject}`)}`,
      `DESCRIPTION:${esc(`Prépare le cours du ${fmtDay(String(s.target).slice(0, 10))}${chap}`)}`,
      'CATEGORIES:Révision', 'TRANSP:TRANSPARENT');
    if (alarmMinutes > 0) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc('Révision : ' + s.subject)}`, `TRIGGER:-PT${alarmMinutes}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { text: lines.map(fold).join('\r\n') + '\r\n', count };
}
