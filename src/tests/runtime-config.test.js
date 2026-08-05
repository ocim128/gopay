// Tests for the Config Service (runtime-config.js).
//
// These exercise the three server-level settings against a real in-memory DAL
// (no mocks): validation on set, HTTP-400 rejection of invalid values, the
// retain-previous-value guarantee, default fallbacks, and durable round-trips.
// The Static_QRIS validation reuses the QRIS_Builder, so a value stored here
// round-trips to exactly what the builder reads.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { buildDynamicQris } from '../payment/qris-builder.js';
import {
  CONFIG_KEYS,
  ConfigValidationError,
  DEFAULT_POLL_INTERVAL_MS,
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_MIN_MS,
  WEBHOOK_URL_MAX_LENGTH,
  createConfigService,
} from '../config/runtime-config.js';

// A real, structurally valid Static_QRIS (a single-merchant GoPay payload) with
// a correct trailing CRC16, used to verify positive Static_QRIS handling.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

describe('createConfigService', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {ReturnType<typeof createConfigService>} */
  let config;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    config = createConfigService(storage);
  });

  afterEach(() => {
    storage.close();
  });

  it('rejects a non-conforming storage instance', () => {
    expect(() => createConfigService({})).toThrow(/Storage contract/);
  });

  // ---- poll_interval -------------------------------------------------------

  describe('poll_interval', () => {
    it('returns the default when unset', () => {
      expect(config.getPollInterval()).toBe(DEFAULT_POLL_INTERVAL_MS);
    });

    it('stores and reads back a valid value', () => {
      expect(config.setPollInterval(3000)).toBe(3000);
      expect(config.getPollInterval()).toBe(3000);
      expect(storage.config.get(CONFIG_KEYS.POLL_INTERVAL)).toBe('3000');
    });

    it('accepts the inclusive range bounds', () => {
      config.setPollInterval(POLL_INTERVAL_MIN_MS);
      expect(config.getPollInterval()).toBe(POLL_INTERVAL_MIN_MS);
      config.setPollInterval(POLL_INTERVAL_MAX_MS);
      expect(config.getPollInterval()).toBe(POLL_INTERVAL_MAX_MS);
    });

    it('accepts an integer-denoting string', () => {
      expect(config.setPollInterval('4500')).toBe(4500);
      expect(config.getPollInterval()).toBe(4500);
    });

    it.each([
      ['below the minimum', POLL_INTERVAL_MIN_MS - 1],
      ['above the maximum', POLL_INTERVAL_MAX_MS + 1],
      ['non-integer number', 1500.5],
      ['NaN', Number.NaN],
      ['non-numeric string', 'fast'],
      ['empty string', ''],
      ['null', null],
      ['boolean', true],
    ])('rejects an invalid value (%s) with HTTP 400 and retains the previous value', (_label, bad) => {
      config.setPollInterval(2000);
      expect(() => config.setPollInterval(bad)).toThrow(ConfigValidationError);
      try {
        config.setPollInterval(bad);
      } catch (err) {
        expect(err.http).toBe(400);
        expect(err.code).toBe('INVALID_REQUEST');
      }
      // Previous value is retained on rejection.
      expect(config.getPollInterval()).toBe(2000);
    });
  });

  // ---- webhook_url ---------------------------------------------------------

  describe('webhook_url', () => {
    it('returns null when unset', () => {
      expect(config.getDefaultWebhookUrl()).toBeNull();
    });

    it.each([
      'http://example.com/hook',
      'https://example.com/path?x=1',
      'https://sub.example.com:8443/webhooks/gopay',
    ])('stores and reads back a valid URL (%s)', (url) => {
      expect(config.setDefaultWebhookUrl(url)).toBe(url);
      expect(config.getDefaultWebhookUrl()).toBe(url);
    });

    it.each([
      ['relative URL', '/just/a/path'],
      ['non-http scheme', 'ftp://example.com/x'],
      ['not a URL', 'not a url'],
      ['empty string', ''],
      ['null', null],
      ['too long', `https://example.com/${'a'.repeat(WEBHOOK_URL_MAX_LENGTH)}`],
    ])('rejects an invalid URL (%s) with HTTP 400 and retains the previous value', (_label, bad) => {
      config.setDefaultWebhookUrl('https://kept.example.com/hook');
      expect(() => config.setDefaultWebhookUrl(bad)).toThrow(ConfigValidationError);
      try {
        config.setDefaultWebhookUrl(bad);
      } catch (err) {
        expect(err.http).toBe(400);
        expect(err.code).toBe('INVALID_WEBHOOK_URL');
      }
      expect(config.getDefaultWebhookUrl()).toBe('https://kept.example.com/hook');
    });

    it('accepts a URL exactly at the maximum length', () => {
      const base = 'https://example.com/';
      const url = base + 'a'.repeat(WEBHOOK_URL_MAX_LENGTH - base.length);
      expect(url.length).toBe(WEBHOOK_URL_MAX_LENGTH);
      expect(config.setDefaultWebhookUrl(url)).toBe(url);
    });
  });

  // ---- static_qris ---------------------------------------------------------

  describe('static_qris', () => {
    it('returns null when unset', () => {
      expect(config.getStaticQris()).toBeNull();
    });

    it('stores a valid Static_QRIS and round-trips to what the builder reads', () => {
      const stored = config.setStaticQris(VALID_STATIC_QRIS);
      expect(config.getStaticQris()).toBe(stored);
      // The QRIS_Builder consumes the stored value without error.
      expect(() => buildDynamicQris(config.getStaticQris(), 12345)).not.toThrow();
    });

    it('trims surrounding whitespace before storing', () => {
      const stored = config.setStaticQris(`   ${VALID_STATIC_QRIS}   `);
      expect(stored).toBe(VALID_STATIC_QRIS);
      expect(config.getStaticQris()).toBe(VALID_STATIC_QRIS);
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['malformed structure', 'NOT-A-QRIS-PAYLOAD'],
      ['null', null],
      [
        'invalid CRC16',
        '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304FFFF',
      ],
    ])('rejects an invalid Static_QRIS (%s) with HTTP 400 and retains the previous value', (_label, bad) => {
      config.setStaticQris(VALID_STATIC_QRIS);
      expect(() => config.setStaticQris(bad)).toThrow(ConfigValidationError);
      try {
        config.setStaticQris(bad);
      } catch (err) {
        expect(err.http).toBe(400);
        expect(err.code).toBe('INVALID_REQUEST');
      }
      expect(config.getStaticQris()).toBe(VALID_STATIC_QRIS);
    });
  });

  // ---- display_timezone ----------------------------------------------------

  describe('display_timezone', () => {
    it('returns the default (Asia/Jakarta) when unset', () => {
      expect(config.getDisplayTimezone()).toBe('Asia/Jakarta');
    });

    it.each(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'UTC', 'America/New_York'])(
      'stores and reads back a valid IANA zone (%s)',
      (zone) => {
        expect(config.setDisplayTimezone(zone)).toBe(zone);
        expect(config.getDisplayTimezone()).toBe(zone);
        expect(storage.config.get(CONFIG_KEYS.DISPLAY_TIMEZONE)).toBe(zone);
      },
    );

    it.each([
      ['unknown zone', 'Mars/Phobos'],
      ['abbreviation, not IANA', 'WIB'],
      ['empty string', ''],
      ['null', null],
      ['number', 7],
    ])('rejects an invalid zone (%s) with HTTP 400 and retains the previous value', (_label, bad) => {
      config.setDisplayTimezone('Asia/Makassar');
      expect(() => config.setDisplayTimezone(bad)).toThrow(ConfigValidationError);
      try {
        config.setDisplayTimezone(bad);
      } catch (err) {
        expect(err.http).toBe(400);
        expect(err.code).toBe('INVALID_REQUEST');
      }
      expect(config.getDisplayTimezone()).toBe('Asia/Makassar');
    });

    it('defensively falls back to the default if a stored value is no longer valid', () => {
      // Write an invalid value directly through the DAL, bypassing validation.
      storage.config.set(CONFIG_KEYS.DISPLAY_TIMEZONE, 'Mars/Phobos');
      expect(config.getDisplayTimezone()).toBe('Asia/Jakarta');
    });
  });

  // ---- persistence ---------------------------------------------------------

  it('persists values through the DAL so a fresh service reads them back', () => {
    config.setPollInterval(12000);
    config.setDefaultWebhookUrl('https://example.com/hook');
    config.setStaticQris(VALID_STATIC_QRIS);
    config.setDisplayTimezone('Asia/Makassar');

    // A new service over the same storage observes the persisted values.
    const reopened = createConfigService(storage);
    expect(reopened.getPollInterval()).toBe(12000);
    expect(reopened.getDefaultWebhookUrl()).toBe('https://example.com/hook');
    expect(reopened.getStaticQris()).toBe(VALID_STATIC_QRIS);
    expect(reopened.getDisplayTimezone()).toBe('Asia/Makassar');
  });
});
