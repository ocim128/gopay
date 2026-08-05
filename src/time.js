// Timestamp representation helpers.
//
// The System stores every Payment timestamp (`created_at`, `expires_at`,
// `paid_at`) as an integer number of milliseconds since the Unix epoch (UTC).
// Epoch-ms is timezone-agnostic: it identifies one absolute instant, exactly
// like the GoBiz ISO-8601 timestamps that carry a `+07:00` offset. The two are
// the SAME instant in different representations, so there is never a timezone
// "conflict" between our stored values and GoBiz.
//
// For the REST_API we additionally expose human-readable, offset-aware
// ISO-8601 strings. The instant itself is always the epoch-ms value; the ISO
// sibling renders that same instant in a chosen IANA timezone (default
// `Asia/Jakarta`, WIB, `+07:00`). Because the stored value is the absolute
// instant, the display zone is purely cosmetic and can be chosen freely per
// request without any risk of drift: GoBiz always reports `+07:00` and we
// normalize to epoch-ms, so a `Asia/Makassar` (+08:00) or UTC rendering of the
// SAME instant is exact. Emitting the offset (rather than a bare `Z`) keeps the
// value unambiguous. The epoch-ms fields remain in every response, so this is
// purely additive and never breaks an existing integration.
//
// All zone logic uses the runtime's native `Intl` API (Node 20+ ships full IANA
// data), avoiding the `moment-timezone` dependency entirely.

/**
 * The default display timezone for the System (Western Indonesia Time, WIB).
 * GoBiz reports transaction times in this zone, the host is configured to it
 * (see `ecosystem.config.cjs` `TZ`), and the panel renders wall-clock time in
 * it unless a payment or the server Config overrides the zone.
 *
 * @type {string}
 */
export const DISPLAY_TIMEZONE = 'Asia/Jakarta';

/**
 * Alias for {@link DISPLAY_TIMEZONE} read as "the fallback when no explicit zone
 * is supplied". Kept as a separate named export so callers that mean "the
 * default" read clearly at the call site.
 *
 * @type {string}
 */
export const DEFAULT_DISPLAY_TIMEZONE = DISPLAY_TIMEZONE;

/**
 * Cache of validated timezone names. `Intl.DateTimeFormat` construction is the
 * validation primitive, and recognizing the same zone is repeated on every
 * payment create / config set / webhook dispatch path, so the affirmative
 * results are memoized. Negative results are NOT cached (so a future zone
 * database update is picked up).
 *
 * @type {Set<string>}
 */
const validTimezoneCache = new Set();

/**
 * Report whether a value is a recognized IANA timezone name (e.g.
 * `Asia/Jakarta`, `Asia/Makassar`, `UTC`). Backed by the runtime's native
 * `Intl.DateTimeFormat`, which rejects unknown zones by throwing — so a
 * successful construction is the precise signal for "known IANA zone".
 *
 * @param {unknown} timeZone - the candidate timezone name.
 * @returns {boolean} true when `timeZone` is a known IANA zone.
 */
export function isValidTimezone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    return false;
  }
  if (validTimezoneCache.has(timeZone)) {
    return true;
  }
  try {
    // Constructing a formatter with an unknown timeZone throws RangeError.
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone });
    validTimezoneCache.add(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pad a number to two digits with a leading zero.
 *
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Pad a number to three digits with leading zeros (for millisecond fractions).
 *
 * @param {number} n
 * @returns {string}
 */
function pad3(n) {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return String(n);
}

/**
 * Format the UTC offset of `epochMs` in the given zone as a `±HH:MM` string
 * (e.g. `+07:00`, `-05:30`, `+00:00`). Uses the `timeZoneName: 'longOffset'`
 * part when available (Node 14+), falling back to a manual sign/minutes
 * computation from the numeric offset.
 *
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {string}
 */
function formatOffset(epochMs, timeZone) {
  // Prefer the longOffset part, which yields `GMT+07:00` (or `GMT` for +00:00).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(epochMs);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName');
  if (offsetPart) {
    const value = offsetPart.value;
    // "GMT" alone means +00:00.
    if (value === 'GMT') return '+00:00';
    // "GMT+07:00" -> "+07:00"; "GMT-05:30" -> "-05:30".
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(value);
    if (match) {
      return `${match[1]}${match[2]}:${match[3]}`;
    }
  }
  // Fallback: derive the offset from the difference between the zone's local
  // time and the UTC time, in minutes.
  const local = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(epochMs),
  );
  const utc = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(epochMs),
  );
  const diffMs = local.getTime() - utc.getTime();
  const totalMinutes = Math.round(diffMs / 60000);
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Render an epoch-millisecond timestamp as an offset-aware ISO-8601 string in
 * the given IANA timezone (e.g. `2026-06-28T23:20:46.904+07:00` for
 * `Asia/Jakarta`, or `...+08:00` for `Asia/Makassar`).
 *
 * The returned string keeps the zone's numeric offset (e.g. `+07:00`, `+08:00`,
 * or `+00:00` for UTC) rather than a bare `Z`, so it is unambiguous. When
 * `timeZone` is missing or not a recognized IANA zone it falls back to
 * {@link DISPLAY_TIMEZONE}, so a bad zone never throws here — zone validation
 * belongs at the input boundary. A nullish or non-finite `epochMs` returns
 * `null` so callers can pass "no timestamp yet" (e.g. an unpaid Payment's
 * `paid_at`) straight through.
 *
 * Implemented natively via `Intl.DateTimeFormat.formatToParts`; the output is
 * byte-identical to the previous `moment(epochMs).tz(zone).toISOString(true)`.
 *
 * @param {number|null|undefined} epochMs - milliseconds since the Unix epoch.
 * @param {string} [timeZone] - the IANA zone to render in; defaults to
 *   {@link DISPLAY_TIMEZONE}.
 * @returns {string|null} the offset-aware ISO-8601 string, or `null`.
 */
export function toZonedIso(epochMs, timeZone) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    return null;
  }
  const zone = isValidTimezone(timeZone) ? timeZone : DISPLAY_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  }).formatToParts(epochMs);
  /** @type {Record<string, string>} */
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  // `hour: '2-digit', hour12: false` can yield "24" on some runtimes; normalize
  // "24" to "00" for ISO compliance.
  const hour = map.hour === '24' ? '00' : map.hour;
  const iso = `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}.${pad3(Number(map.fractionalSecond))}`;
  return `${iso}${formatOffset(epochMs, zone)}`;
}

/**
 * Render an epoch-millisecond timestamp as an offset-aware ISO-8601 string in
 * {@link DISPLAY_TIMEZONE} (WIB, `+07:00`). Thin wrapper over
 * {@link toZonedIso} kept for the default-zone call sites.
 *
 * @param {number|null|undefined} epochMs - milliseconds since the Unix epoch.
 * @returns {string|null} the ISO-8601 `+07:00` string, or `null`.
 */
export function toJakartaIso(epochMs) {
  return toZonedIso(epochMs, DISPLAY_TIMEZONE);
}

/**
 * Convert a "wall-clock" instant (a year/month/day/hour/... tuple interpreted
 * in the given IANA timezone) to its UTC epoch-millisecond value. This is the
 * inverse of formatting: it answers "what absolute instant corresponds to
 * midnight local time on this date?".
 *
 * Implemented via the well-known round-trip trick: format the candidate UTC
 * instant in the target zone, compare the wall-clock fields, and apply the
 * observed offset correction. This avoids depending on any third-party
 * timezone library while still honouring DST and zone rules.
 *
 * @param {number} year
 * @param {number} month - 1-based month (1..12), matching `Date` constructor
 *   convention used elsewhere in the codebase.
 * @param {number} day - day of month (1..31).
 * @param {number} [hours=0]
 * @param {number} [minutes=0]
 * @param {number} [seconds=0]
 * @param {string} [timeZone] - the IANA zone to interpret the wall-clock in;
 *   defaults to {@link DISPLAY_TIMEZONE}.
 * @returns {number} epoch milliseconds.
 */
export function wallClockToEpochMs(
  year,
  month,
  day,
  hours = 0,
  minutes = 0,
  seconds = 0,
  timeZone = DISPLAY_TIMEZONE,
) {
  const zone = isValidTimezone(timeZone) ? timeZone : DISPLAY_TIMEZONE;
  // First guess: pretend the wall-clock IS UTC. The offset between this guess
  // and the same instant rendered in `zone` tells us how to correct.
  const guessUtc = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  const rendered = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(guessUtc);
  /** @type {Record<string, string>} */
  const m = {};
  for (const p of rendered) m[p.type] = p.value;
  const zYear = Number(m.year);
  const zMonth = Number(m.month);
  const zDay = Number(m.day);
  const zHour = m.hour === '24' ? 0 : Number(m.hour);
  const zMinute = Number(m.minute);
  const zSecond = Number(m.second);
  // The actual UTC instant that produces the zone's wall-clock fields. Re-derive
  // from the zone's wall-clock and apply the offset (guessUtc - zoneUtcGuess).
  const zoneUtcGuess = Date.UTC(zYear, zMonth - 1, zDay, zHour, zMinute, zSecond);
  const offset = guessUtc - zoneUtcGuess;
  return guessUtc + offset;
}
