// Unit tests for the timestamp representation helpers.

import { describe, it, expect } from 'vitest';

import { toJakartaIso, toZonedIso, isValidTimezone, DISPLAY_TIMEZONE, DEFAULT_DISPLAY_TIMEZONE, wallClockToEpochMs } from '../time.js';

describe('toJakartaIso', () => {
  it('renders an offset-aware Asia/Jakarta (+07:00) ISO-8601 string', () => {
    // 2026-06-28T16:20:46.904Z === 2026-06-28T23:20:46.904+07:00 (WIB).
    const epochMs = Date.parse('2026-06-28T16:20:46.904Z');
    const iso = toJakartaIso(epochMs);
    expect(iso).toBe('2026-06-28T23:20:46.904+07:00');
  });

  it('round-trips to the same absolute instant as the epoch-ms input', () => {
    const epochMs = 1782688846904;
    const iso = toJakartaIso(epochMs);
    expect(iso).toMatch(/\+07:00$/);
    expect(new Date(iso).getTime()).toBe(epochMs);
  });

  it('returns null for nullish or non-finite input', () => {
    expect(toJakartaIso(null)).toBeNull();
    expect(toJakartaIso(undefined)).toBeNull();
    expect(toJakartaIso(Number.NaN)).toBeNull();
    expect(toJakartaIso(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toJakartaIso('1700000000000')).toBeNull();
  });

  it('exposes Asia/Jakarta as the display timezone', () => {
    expect(DISPLAY_TIMEZONE).toBe('Asia/Jakarta');
    expect(DEFAULT_DISPLAY_TIMEZONE).toBe('Asia/Jakarta');
  });
});

describe('isValidTimezone', () => {
  it('accepts recognized IANA zone names', () => {
    for (const zone of ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'UTC', 'America/New_York']) {
      expect(isValidTimezone(zone)).toBe(true);
    }
  });

  it('rejects unknown zones and non-strings', () => {
    for (const bad of ['Mars/Phobos', 'Not/AZone', '', 'WIB', null, undefined, 7, {}]) {
      expect(isValidTimezone(bad)).toBe(false);
    }
  });
});

describe('toZonedIso', () => {
  // 2026-06-28T16:20:46.904Z is one fixed absolute instant.
  const epochMs = Date.parse('2026-06-28T16:20:46.904Z');

  it('renders the requested zone offset (WIB +07:00, WITA +08:00, WIT +09:00)', () => {
    expect(toZonedIso(epochMs, 'Asia/Jakarta')).toBe('2026-06-28T23:20:46.904+07:00');
    expect(toZonedIso(epochMs, 'Asia/Makassar')).toBe('2026-06-29T00:20:46.904+08:00');
    expect(toZonedIso(epochMs, 'Asia/Jayapura')).toBe('2026-06-29T01:20:46.904+09:00');
  });

  it('renders UTC with a +00:00 offset', () => {
    // toISOString(true) keeps the zone's numeric offset; for UTC that is +00:00.
    expect(toZonedIso(epochMs, 'UTC')).toBe('2026-06-28T16:20:46.904+00:00');
  });

  it('keeps the same absolute instant across every zone', () => {
    for (const zone of ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'UTC']) {
      expect(new Date(toZonedIso(epochMs, zone)).getTime()).toBe(epochMs);
    }
  });

  it('falls back to the default display zone for a missing or unknown zone', () => {
    const expected = toJakartaIso(epochMs);
    expect(toZonedIso(epochMs, undefined)).toBe(expected);
    expect(toZonedIso(epochMs, 'Mars/Phobos')).toBe(expected);
    expect(toZonedIso(epochMs, '')).toBe(expected);
  });

  it('returns null for nullish or non-finite input regardless of zone', () => {
    expect(toZonedIso(null, 'UTC')).toBeNull();
    expect(toZonedIso(Number.NaN, 'Asia/Makassar')).toBeNull();
  });
});

describe('wallClockToEpochMs', () => {
  it('interprets a wall-clock date in the given IANA zone', () => {
    // 2026-01-15T00:00:00+07:00 (Asia/Jakarta) === 2026-01-14T17:00:00.000Z
    const ms = wallClockToEpochMs(2026, 1, 15, 0, 0, 0, 'Asia/Jakarta');
    expect(new Date(ms).toISOString()).toBe('2026-01-14T17:00:00.000Z');
  });

  it('honours a non-default zone (Asia/Makassar +08:00)', () => {
    // 2026-01-15T00:00:00+08:00 === 2026-01-14T16:00:00.000Z
    const ms = wallClockToEpochMs(2026, 1, 15, 0, 0, 0, 'Asia/Makassar');
    expect(new Date(ms).toISOString()).toBe('2026-01-14T16:00:00.000Z');
  });

  it('UTC zone yields the same instant as Date.UTC', () => {
    const ms = wallClockToEpochMs(2026, 1, 15, 12, 30, 45, 'UTC');
    expect(ms).toBe(Date.UTC(2026, 0, 15, 12, 30, 45));
  });

  it('rolls day-of-month overflow into the next month', () => {
    // Jan 32 === Feb 1; both start-of-day in WIB, exactly 24h apart.
    const start = wallClockToEpochMs(2026, 1, 31, 0, 0, 0, 'Asia/Jakarta');
    const end = wallClockToEpochMs(2026, 1, 32, 0, 0, 0, 'Asia/Jakarta');
    expect(new Date(start).toISOString()).toBe('2026-01-30T17:00:00.000Z');
    expect(new Date(end).toISOString()).toBe('2026-01-31T17:00:00.000Z');
    expect(end - start).toBe(24 * 60 * 60 * 1000);
  });

  it('falls back to the default zone for an unknown zone name', () => {
    const ok = wallClockToEpochMs(2026, 1, 15, 0, 0, 0, 'Mars/Phobos');
    const def = wallClockToEpochMs(2026, 1, 15, 0, 0, 0, 'Asia/Jakarta');
    expect(ok).toBe(def);
  });
});
