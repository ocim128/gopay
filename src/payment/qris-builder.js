// Dynamic QRIS builder + CRC16.
//
// Builds a Dynamic_QRIS from a Static_QRIS by toggling the point-of-initiation
// method (static `010211` -> dynamic `010212`), injecting the amount into EMV
// field `54`, keeping the country code field `5802ID`, and recomputing the
// trailing CRC16-CCITT checksum.
//
// IMPORTANT: this builder does NOT read configuration or environment variables.
// The caller (the Payment_Service) is responsible for loading the Static_QRIS
// from Config and passing it in as `staticQris`. When the supplied Static_QRIS
// is absent or malformed (unparseable structure or a wrong trailing CRC16),
// the builder throws a `QrisError` whose `code` is `QRIS_INVALID`, so the route
// layer can map it to HTTP 500 `QRIS_INVALID`.

import crc from 'crc';
import QRCode from 'qrcode';

import { getErrorDefinition } from '../errors.js';

/**
 * The error code this module raises for an absent or malformed Static_QRIS.
 * It matches a key in the central error map (`src/errors.js`).
 *
 * @type {'QRIS_INVALID'}
 */
export const QRIS_ERROR_CODE = 'QRIS_INVALID';

/**
 * Error thrown when a Static_QRIS cannot be used to build a Dynamic_QRIS.
 *
 * The `code` property is always `QRIS_INVALID` so that the route layer can map
 * it to the corresponding HTTP status and response body via the central error
 * map without needing to know about this module.
 */
export class QrisError extends Error {
  /**
   * @param {string} [message] - optional English detail message. Defaults to
   *   the registered `QRIS_INVALID` message from the central error map.
   */
  constructor(message) {
    const fallback = getErrorDefinition(QRIS_ERROR_CODE).message;
    super(message ?? fallback);
    this.name = 'QrisError';
    /** @type {'QRIS_INVALID'} */
    this.code = QRIS_ERROR_CODE;
  }
}

/**
 * Compute the EMVCo CRC16-CCITT checksum of a string and return it as an
 * upper-case, zero-padded, 4-character hexadecimal value.
 *
 * @param {string} str - the content to checksum (everything up to and
 *   including the `6304` CRC tag).
 * @returns {string} the 4-character upper-case hex CRC16-CCITT.
 */
export function convertCRC16(str) {
  const crc16 = crc.crc16ccitt(Buffer.from(str, 'utf8')).toString(16).toUpperCase();
  return ('0000' + crc16).slice(-4);
}

/**
 * Normalize and validate a Static_QRIS string.
 *
 * Accepts either a complete QRIS that ends with the `6304` CRC tag followed by
 * a 4-character checksum, or the "tag-only" form that ends with `6304` (no
 * checksum value). For the complete form the trailing CRC16 is verified.
 *
 * @param {unknown} staticQris - the candidate Static_QRIS (as read from Config).
 * @returns {string} the trimmed Static_QRIS, guaranteed to be structurally
 *   valid and (where present) to carry a correct trailing CRC16.
 * @throws {QrisError} when the value is absent or malformed.
 */
export function validateStaticQris(staticQris) {
  if (typeof staticQris !== 'string' || staticQris.trim().length === 0) {
    throw new QrisError('The static QRIS is absent or empty.');
  }

  const qris = staticQris.trim();

  // The country code field is mandatory in a QRIS payload and is the anchor
  // used to inject the amount field. Its absence means the payload cannot be
  // parsed as a QRIS.
  if (!qris.includes('5802ID')) {
    throw new QrisError('The static QRIS is malformed: missing the country code field (5802ID).');
  }

  // "Tag-only" form: ends with the CRC tag but carries no checksum value yet.
  // There is nothing to verify, so accept it as-is.
  if (qris.endsWith('6304')) {
    return qris;
  }

  // Complete form: the last 4 characters are the CRC16 over everything up to
  // and including the `6304` tag.
  const crcTagIndex = qris.length - 8;
  if (crcTagIndex < 0 || qris.slice(crcTagIndex, crcTagIndex + 4) !== '6304') {
    throw new QrisError('The static QRIS is malformed: missing the CRC16 tag (6304).');
  }

  const payloadWithTag = qris.slice(0, crcTagIndex + 4);
  const providedCrc = qris.slice(crcTagIndex + 4).toUpperCase();
  const expectedCrc = convertCRC16(payloadWithTag);

  if (providedCrc !== expectedCrc) {
    throw new QrisError('The static QRIS is malformed: the CRC16 checksum is invalid.');
  }

  return qris;
}

/**
 * Build a Dynamic_QRIS from a Static_QRIS by injecting the amount.
 *
 * Steps:
 *   1. Strip the trailing 4-character CRC value (keeping the `6304` tag).
 *   2. Toggle the point-of-initiation method from static `010211` to dynamic
 *      `010212`.
 *   3. Inject EMV field `54` (the transaction amount) immediately before the
 *      country code field `5802ID`.
 *   4. Recompute and append the CRC16-CCITT over the entire preceding content.
 *
 * @param {unknown} staticQris - the Static_QRIS as read from Config.
 * @param {number} amount - the transaction amount in Rupiah (positive integer).
 * @returns {string} the Dynamic_QRIS with the amount embedded and a valid CRC16.
 * @throws {QrisError} when the Static_QRIS is absent or malformed.
 */
export function buildDynamicQris(staticQris, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new QrisError('The amount must be a positive integer.');
  }

  const qris = validateStaticQris(staticQris);

  // Keep the `6304` tag but drop any existing CRC value before rebuilding.
  const data = qris.endsWith('6304') ? qris : qris.slice(0, -4);
  const step1 = data.replace('010211', '010212');

  if (!step1.includes('5802ID')) {
    throw new QrisError('The static QRIS is malformed: missing the country code field (5802ID).');
  }

  const [before, after] = step1.split('5802ID');
  const amountText = amount.toString();
  const nominalField = '54' + String(amountText.length).padStart(2, '0') + amountText;
  const raw = before + nominalField + '5802ID' + after;

  return raw + convertCRC16(raw);
}

/**
 * Render a QRIS string to a PNG image buffer.
 *
 * The Payment_Service can wrap this into a data URL or serve it from an
 * internal endpoint; this function only produces the raw PNG bytes.
 *
 * @param {string} qrisString - the (dynamic) QRIS string to encode.
 * @returns {Promise<Buffer>} the PNG image bytes.
 */
export async function generateQrisImage(qrisString) {
  const dataUrl = await QRCode.toDataURL(qrisString, { scale: 8, errorCorrectionLevel: 'M' });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}
