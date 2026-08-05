// Unit tests for the realtime event bus.

import { describe, it, expect, vi } from 'vitest';

import { createEventBus } from '../events/event-bus.js';

describe('createEventBus', () => {
  it('delivers an emitted payment signal to subscribers', () => {
    const bus = createEventBus();
    const received = [];
    bus.subscribe((event) => received.push(event));

    bus.emitPayment('paid', { id: 'pay-1', status: 'paid' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'paid', payment_id: 'pay-1', status: 'paid' });
    expect(typeof received[0].at).toBe('number');
  });

  it('supports multiple subscribers and reports the listener count', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    expect(bus.listenerCount()).toBe(2);

    bus.emitPayment('created', { id: 'pay-2', status: 'pending' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = createEventBus();
    const listener = vi.fn();
    const off = bus.subscribe(listener);

    bus.emitPayment('paid', { id: 'pay-3' });
    off();
    bus.emitPayment('expired', { id: 'pay-3', status: 'expired' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it('ignores malformed payments (no id) and never throws with zero listeners', () => {
    const bus = createEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);

    bus.emitPayment('paid', null);
    bus.emitPayment('paid', {});
    expect(listener).not.toHaveBeenCalled();

    const empty = createEventBus();
    expect(() => empty.emitPayment('paid', { id: 'x' })).not.toThrow();
  });
});
