// Unit tests for QRIS_INVALID on absent/malformed Static_QRIS.
//
// These tests verify that `buildDynamicQris` rejects an absent or malformed
// Static_QRIS by throwing a `QrisError` whose `.code` is `QRIS_INVALID`, so the
// route layer can map it to HTTP 500 `QRIS_INVALID`.

import { describe, it, expect } from 'vitest';

import {
  buildDynamicQris,
  convertCRC16,
  QrisError,
  QRIS_ERROR_CODE,
} from '../payment/qris-builder.js';

// A structurally valid Static_QRIS payload up to and including the `6304` CRC
// tag. It carries the mandatory `5802ID` country-code field and the static
// point-of-initiation method `010211`. The trailing CRC16 is computed with the
// module's own `convertCRC16` so the example is guaranteed correct.
const VALID_PAYLOAD_WITH_TAG =
  '00020101021126660014ID.CO.QRIS.WWW0118ID1024123456789012345802ID53033606304';
const VALID_STATIC_QRIS = VALID_PAYLOAD_WITH_TAG + convertCRC16(VALID_PAYLOAD_WITH_TAG);

const AMOUNT = 12345;

describe('buildDynamicQris - QRIS_INVALID on absent/malformed Static_QRIS', () => {
  // Sanity check: the chosen example is a usable, valid Static_QRIS so that the
  // failing cases below are isolating the malformation under test.
  it('builds a Dynamic_QRIS from a valid Static_QRIS (control)', () => {
    expect(() => buildDynamicQris(VALID_STATIC_QRIS, AMOUNT)).not.toThrow();
  });

  describe('absent Static_QRIS', () => {
    const absentCases = [
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace-only string', '   \t\n  '],
    ];

    for (const [label, value] of absentCases) {
      it(`throws QRIS_INVALID for an absent Static_QRIS (${label})`, () => {
        expect(() => buildDynamicQris(value, AMOUNT)).toThrow(QrisError);
        try {
          buildDynamicQris(value, AMOUNT);
          throw new Error('expected buildDynamicQris to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(QrisError);
          expect(err.code).toBe('QRIS_INVALID');
          expect(err.code).toBe(QRIS_ERROR_CODE);
        }
      });
    }
  });

  describe('structurally unparseable Static_QRIS', () => {
    it('throws QRIS_INVALID when the country code field (5802ID) is missing', () => {
      // No `5802ID` anchor: the payload cannot be parsed as a QRIS.
      const noCountryCode = '0002010102116304ABCD';
      expect(() => buildDynamicQris(noCountryCode, AMOUNT)).toThrow(QrisError);
      try {
        buildDynamicQris(noCountryCode, AMOUNT);
        throw new Error('expected buildDynamicQris to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(QrisError);
        expect(err.code).toBe('QRIS_INVALID');
      }
    });

    it('throws QRIS_INVALID when the CRC16 tag (6304) is missing', () => {
      // Has `5802ID` but no trailing `6304` tag in the final field position.
      const noCrcTag = '00020101021126660014ID.CO.QRIS.WWW5802ID530336540512345';
      expect(() => buildDynamicQris(noCrcTag, AMOUNT)).toThrow(QrisError);
      try {
        buildDynamicQris(noCrcTag, AMOUNT);
        throw new Error('expected buildDynamicQris to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(QrisError);
        expect(err.code).toBe('QRIS_INVALID');
      }
    });
  });

  describe('Static_QRIS with a wrong trailing CRC16', () => {
    it('throws QRIS_INVALID when the trailing CRC16 does not match', () => {
      // Take the valid payload (ending in `6304`) and append a deliberately
      // wrong checksum so the structure parses but the CRC verification fails.
      const wrongCrc = VALID_PAYLOAD_WITH_TAG + '0000';
      // Guard the test against accidentally picking the correct checksum.
      expect(wrongCrc).not.toBe(VALID_STATIC_QRIS);

      expect(() => buildDynamicQris(wrongCrc, AMOUNT)).toThrow(QrisError);
      try {
        buildDynamicQris(wrongCrc, AMOUNT);
        throw new Error('expected buildDynamicQris to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(QrisError);
        expect(err.code).toBe('QRIS_INVALID');
      }
    });
  });
});
