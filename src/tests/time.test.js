// Unit tests for the timestamp representation helpers.

import { describe, it, expect } from 'vitest';

import { toJakartaIso, toZonedIso, isValidTimezone, DISPLAY_TIMEZONE, DEFAULT_DISPLAY_TIMEZONE } from '../time.js';

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
