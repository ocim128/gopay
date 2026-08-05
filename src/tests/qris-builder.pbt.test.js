// Property-based test for the Dynamic QRIS builder.
//
// For any valid integer Amount in 1000..9999000 and a
// valid Static_QRIS, the Dynamic_QRIS produced by `buildDynamicQris` SHALL
//   (a) embed the Amount in EMV field `54` such that decoding field `54`
//       yields exactly that Amount, and
//   (b) carry a correct trailing CRC16-CCITT, i.e. its last 4 characters equal
//       the checksum recomputed (via `convertCRC16`) over everything that
//       precedes them.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { buildDynamicQris, convertCRC16 } from '../payment/qris-builder.js';

// A known-valid Static_QRIS whose trailing CRC16 is correct. The builder
// validates this checksum before building, so an incorrect value here would
// cause every run to throw.
const STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

/**
 * Walk an EMV-Co QRIS payload as top-level TLV entries (2-char tag, 2-char
 * length, then `length` characters of value) and return the value of the first
 * entry whose tag matches `wantedTag`.
 *
 * This is an independent decoder: it does not reuse any of the builder's
 * injection logic, so a passing assertion genuinely exercises the round trip.
 *
 * @param {string} payload - the QRIS string excluding its trailing CRC value.
 * @param {string} wantedTag - the 2-character EMV tag to extract (e.g. '54').
 * @returns {string | null} the field value, or null when the tag is absent.
 */
function decodeEmvField(payload, wantedTag) {
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = Number.parseInt(payload.slice(i + 2, i + 4), 10);
    if (!Number.isInteger(len) || len < 0) {
      return null;
    }
    const valueStart = i + 4;
    const value = payload.slice(valueStart, valueStart + len);
    if (tag === wantedTag) {
      return value;
    }
    i = valueStart + len;
  }
  return null;
}

describe('Property 1: QRIS round-trip + valid CRC16', () => {
  it('embeds the amount in field 54 and appends a valid CRC16', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1000, max: 9999000 }), (amount) => {
        const dynamic = buildDynamicQris(STATIC_QRIS, amount);

        // (b) The last 4 characters are the CRC16 over the preceding content.
        const content = dynamic.slice(0, -4);
        const crc = dynamic.slice(-4);
        expect(crc).toBe(convertCRC16(content));

        // (a) Field 54 decodes back to the original amount. Decode over the
        // content (excluding the CRC value) so the trailing checksum cannot be
        // mistaken for TLV data.
        const field54 = decodeEmvField(content, '54');
        expect(field54).not.toBeNull();
        expect(field54).toBe(amount.toString());
        expect(Number.parseInt(field54, 10)).toBe(amount);
      }),
      { numRuns: 100 },
    );
  });
});
