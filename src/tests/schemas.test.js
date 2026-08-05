// Unit tests for the REST_API payment JSON Schemas.
//
// These tests validate the schema objects against the constraints from the
// design using Ajv configured the same way Fastify v4 configures its internal
// validator (coerceTypes + useDefaults), so the behavior here matches what the
// routes will see at runtime.

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';

import {
  createPaymentBodySchema,
  getPaymentParamsSchema,
  listPaymentsQuerySchema,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  TOLERANCE_MAX,
  WEBHOOK_URL_MAX_LENGTH,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  LIST_OFFSET_DEFAULT,
  PAYMENT_MODES,
  paymentRouteSchemas,
} from '../routes/schemas.js';

// Mirror Fastify v4's Ajv defaults relevant to validation/coercion.
function makeValidator(schema) {
  const ajv = new Ajv({
    coerceTypes: 'array',
    useDefaults: true,
    removeAdditional: false,
    allErrors: true,
  });
  return ajv.compile(schema);
}

describe('createPaymentBodySchema', () => {
  it('accepts a well-formed client-managed body within all ranges', () => {
    const validate = makeValidator(createPaymentBodySchema);
    const data = {
      mode: 'client_managed',
      amount: 15000,
      timeout: 300000,
      tolerance: 0,
      webhook_url: 'https://example.com/hook',
    };
    expect(validate(data)).toBe(true);
  });

  it('accepts a server-managed body with base_amount', () => {
    const validate = makeValidator(createPaymentBodySchema);
    expect(validate({ mode: 'server_managed', base_amount: 10000 })).toBe(true);
  });

  it('rejects an unknown mode value', () => {
    const validate = makeValidator(createPaymentBodySchema);
    expect(validate({ mode: 'unknown_mode', amount: 50001 })).toBe(false);
  });

  it('rejects timeout below the minimum', () => {
    const validate = makeValidator(createPaymentBodySchema);
    expect(validate({ timeout: TIMEOUT_MIN_MS - 1 })).toBe(false);
  });

  it('rejects timeout above the maximum', () => {
    const validate = makeValidator(createPaymentBodySchema);
    expect(validate({ timeout: TIMEOUT_MAX_MS + 1 })).toBe(false);
  });

  it('accepts timeout at both inclusive bounds', () => {
    const validate = makeValidator(createPaymentBodySchema);
    expect(validate({ timeout: TIMEOUT_MIN_MS })).toBe(true);
    expect(validate({ timeout: TIMEOUT_MAX_MS })).toBe(true);
  });

  it('rejects a non-integer timeout', () => {
    const validate = makeValidator(createPaymentBodySchema);
    expect(validate({ timeout: 300000.5 })).toBe(false);
  });

  it('rejects tolerance out of range and accepts the bounds', () => {
    const validate = makeValidator(createPaymentBodySchema);
    expect(validate({ tolerance: -1 })).toBe(false);
    expect(validate({ tolerance: TOLERANCE_MAX + 1 })).toBe(false);
    expect(validate({ tolerance: 0 })).toBe(true);
    expect(validate({ tolerance: TOLERANCE_MAX })).toBe(true);
  });

  it('rejects a webhook_url longer than the max length', () => {
    const validate = makeValidator(createPaymentBodySchema);
    const tooLong = 'h'.repeat(WEBHOOK_URL_MAX_LENGTH + 1);
    expect(validate({ webhook_url: tooLong })).toBe(false);
  });

  it('ignores unknown fields such as poll_interval', () => {
    const validate = makeValidator(createPaymentBodySchema);
    const data = { mode: 'client_managed', amount: 50001, poll_interval: 5000 };
    expect(validate(data)).toBe(true);
    // additionalProperties is enabled, so the field is retained, not stripped.
    expect(data.poll_interval).toBe(5000);
  });

  it('does NOT constrain amount/base_amount type (handler emits specific codes)', () => {
    const validate = makeValidator(createPaymentBodySchema);
    // A non-integer amount must still pass the schema so the handler can map
    // it to INVALID_AMOUNT rather than the schema mapping it to INVALID_REQUEST.
    expect(validate({ mode: 'client_managed', amount: 'not-a-number' })).toBe(true);
  });

  it('exposes exactly the two supported payment modes', () => {
    expect([...PAYMENT_MODES]).toEqual(['client_managed', 'server_managed']);
  });
});

describe('getPaymentParamsSchema', () => {
  it('requires a non-empty id', () => {
    const validate = makeValidator(getPaymentParamsSchema);
    expect(validate({ id: 'abc' })).toBe(true);
    expect(validate({ id: '' })).toBe(false);
    expect(validate({})).toBe(false);
  });
});

describe('listPaymentsQuerySchema', () => {
  it('applies default limit and offset when omitted', () => {
    const validate = makeValidator(listPaymentsQuerySchema);
    const data = {};
    expect(validate(data)).toBe(true);
    expect(data.limit).toBe(LIST_LIMIT_DEFAULT);
    expect(data.offset).toBe(LIST_OFFSET_DEFAULT);
  });

  it('coerces numeric query strings to integers', () => {
    const validate = makeValidator(listPaymentsQuerySchema);
    const data = { limit: '50', offset: '10' };
    expect(validate(data)).toBe(true);
    expect(data.limit).toBe(50);
    expect(data.offset).toBe(10);
  });

  it('rejects limit below 1 or above 100', () => {
    const validate = makeValidator(listPaymentsQuerySchema);
    expect(validate({ limit: 0 })).toBe(false);
    expect(validate({ limit: LIST_LIMIT_MAX + 1 })).toBe(false);
  });

  it('rejects a negative offset', () => {
    const validate = makeValidator(listPaymentsQuerySchema);
    expect(validate({ offset: -1 })).toBe(false);
  });
});

describe('paymentRouteSchemas bundle', () => {
  it('groups request and response schemas per endpoint', () => {
    expect(paymentRouteSchemas.createPayment.body).toBe(createPaymentBodySchema);
    expect(paymentRouteSchemas.getPayment.params).toBe(getPaymentParamsSchema);
    expect(paymentRouteSchemas.listPayments.querystring).toBe(listPaymentsQuerySchema);
    expect(paymentRouteSchemas.createPayment.response[201]).toBeDefined();
    expect(paymentRouteSchemas.getPayment.response[200]).toBeDefined();
    expect(paymentRouteSchemas.listPayments.response[200]).toBeDefined();
  });
});
