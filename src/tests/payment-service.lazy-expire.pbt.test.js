// Property-based test for the Payment_Service lazy-expiration behaviour.
//
// For any pending Payment created with timeout `t`,
// reading it via `getPayment` once the clock has advanced past its `expires_at`
// SHALL return `status` `expired`; reading it at or before `expires_at` SHALL
// still return `status` `pending`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createConfigService } from '../config/runtime-config.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { createPaymentService } from '../payment/payment-service.js';

// A real, structurally valid Static_QRIS with a correct trailing CRC16. The
// QRIS_Builder validates this checksum on every build, so an incorrect value
// here would make every run throw.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

describe('Property 10: Lazy-expire', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {ReturnType<typeof createConfigService>} */
  let config;
  /** @type {number} mutable injected clock (epoch ms). */
  let clock;

  beforeEach(async () => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    config = createConfigService(storage);
    await config.setStaticQris(VALID_STATIC_QRIS);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns pending at/before expires_at and expired once now passes it', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Amount within the valid range so the Payment is always creatable.
        fc.integer({ min: 1000, max: 9999000 }),
        // The creation time (epoch ms).
        fc.integer({ min: 0, max: 10_000_000_000 }),
        // Per-Payment timeout t > 0 (ms).
        fc.integer({ min: 1000, max: 86_400_000 }),
        // The overshoot past expires_at, delta > 0 (ms).
        fc.integer({ min: 1000, max: 86_400_000 }),
        async (amount, createdAt, t, delta) => {
          const service = createPaymentService({
            storage,
            config,
            now: () => clock,
          });

          clock = createdAt;
          const created = await service.createPayment({
            mode: 'client',
            amount,
            timeout: t,
          });

          // expires_at is exactly created_at + timeout.
          expect(created.expires_at).toBe(createdAt + t);

          // Reading before expiry: still pending.
          clock = created.expires_at - 1;
          expect((await service.getPayment(created.id)).status).toBe('pending');

          // Reading exactly at expires_at: the boundary has not been passed yet,
          // so the Payment is still pending.
          clock = created.expires_at;
          expect((await service.getPayment(created.id)).status).toBe('pending');

          // Reading after now passes expires_at (delta > 0): expired.
          clock = created.expires_at + delta;
          const afterExpiry = await service.getPayment(created.id);
          expect(afterExpiry.status).toBe('expired');

          // The lazy transition is persisted, not merely computed on read.
          // Once expired, the Payment's Amount is released (the pending-amount
          // unique index only covers pending rows), so a later run that draws
          // the same Amount can still create its own pending Payment.
          expect((await storage.payments.getById(created.id)).status).toBe('expired');
        },
      ),
      { numRuns: 100 },
    );
  });
});
