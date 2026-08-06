// Round-trip test: a Static_QRIS stored via the Config Service is read back by
// the QRIS_Builder from storage (not from env), and a Dynamic_QRIS built from
// that read value succeeds and embeds the transaction amount.
//
// This exercises the seam between `createConfigService` (runtime-config.js) and
// `buildDynamicQris` (qris-builder.js) against a real in-memory SQLite DAL, with
// no mocks: the value the builder consumes is exactly the value the Config
// Service persisted and read back.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { buildDynamicQris } from '../payment/qris-builder.js';
import { createConfigService } from '../config/runtime-config.js';

// A real, structurally valid Static_QRIS (single-merchant GoPay payload) with a
// correct trailing CRC16.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

/**
 * Extract the value of EMV field `54` (the transaction amount) from a QRIS
 * payload by walking its TLV structure from the start. Returns null when the
 * field is absent.
 *
 * @param {string} qris
 * @returns {string|null}
 */
function decodeAmountField(qris) {
  let i = 0;
  while (i + 4 <= qris.length) {
    const tag = qris.slice(i, i + 2);
    const len = Number(qris.slice(i + 2, i + 4));
    if (!Number.isInteger(len)) {
      return null;
    }
    const valueStart = i + 4;
    const value = qris.slice(valueStart, valueStart + len);
    if (tag === '54') {
      return value;
    }
    i = valueStart + len;
  }
  return null;
}

describe('Static_QRIS round-trip: Config Service -> QRIS_Builder', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {ReturnType<typeof createConfigService>} */
  let config;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    config = createConfigService(storage);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('stores a valid Static_QRIS and reads back exactly what was stored', async () => {
    const stored = await config.setStaticQris(VALID_STATIC_QRIS);
    expect(stored).toBe(VALID_STATIC_QRIS);
    // The value read back equals the value the setter persisted.
    expect(await config.getStaticQris()).toBe(stored);
    expect(await config.getStaticQris()).toBe(VALID_STATIC_QRIS);
  });

  it('reads back the trimmed value when stored with surrounding whitespace', async () => {
    const stored = await config.setStaticQris(`  \t ${VALID_STATIC_QRIS} \n `);
    // Trimming behavior: the stored/read value carries no surrounding whitespace.
    expect(stored).toBe(VALID_STATIC_QRIS);
    expect(await config.getStaticQris()).toBe(VALID_STATIC_QRIS);
  });

  it('builds a Dynamic_QRIS from the read value, embedding the amount', async () => {
    await config.setStaticQris(VALID_STATIC_QRIS);

    const amount = 12345;
    const readValue = await config.getStaticQris();

    // The builder consumes the value the Config Service read back, not env.
    let dynamicQris;
    expect(() => {
      dynamicQris = buildDynamicQris(readValue, amount);
    }).not.toThrow();

    // Field 54 decodes to exactly the requested amount.
    expect(decodeAmountField(dynamicQris)).toBe(String(amount));
  });

  it('round-trips the amount for several distinct values', async () => {
    await config.setStaticQris(VALID_STATIC_QRIS);
    const readValue = await config.getStaticQris();

    for (const amount of [1, 1000, 50000, 999999]) {
      const dynamicQris = buildDynamicQris(readValue, amount);
      expect(decodeAmountField(dynamicQris)).toBe(String(amount));
    }
  });
});
