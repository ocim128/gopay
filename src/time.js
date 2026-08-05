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

import moment from 'moment-timezone';

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
 * Report whether a value is a recognized IANA timezone name (e.g.
 * `Asia/Jakarta`, `Asia/Makassar`, `UTC`). Backed by moment-timezone's zone
 * registry, so only zones it knows about are accepted.
 *
 * @param {unknown} timeZone - the candidate timezone name.
 * @returns {boolean} true when `timeZone` is a known IANA zone.
 */
export function isValidTimezone(timeZone) {
  return (
    typeof timeZone === 'string' &&
    timeZone.length > 0 &&
    moment.tz.zone(timeZone) !== null
  );
}

/**
 * Render an epoch-millisecond timestamp as an offset-aware ISO-8601 string in
 * the given IANA timezone (e.g. `2026-06-28T23:20:46.904+07:00` for
 * `Asia/Jakarta`, or `...+08:00` for `Asia/Makassar`).
 *
 * The returned string keeps the zone's numeric offset (e.g. `+07:00`, `+08:00`,
 * or `+00:00` for UTC) rather than a bare `Z`, so it is unambiguous. When
 * `timeZone` is missing or not a recognized IANA zone it falls back to {@link DISPLAY_TIMEZONE}, so a bad zone
 * never throws here — zone validation belongs at the input boundary. A nullish
 * or non-finite `epochMs` returns `null` so callers can pass "no timestamp yet"
 * (e.g. an unpaid Payment's `paid_at`) straight through.
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
  // `toISOString(true)` keeps the local offset instead of converting to UTC.
  return moment(epochMs).tz(zone).toISOString(true);
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
