import { randomUUID } from 'node:crypto';
import { backoffDelayMs, MAX_ATTEMPTS } from './webhook-dispatcher.js';

// The outbox fields are written in the same atomic update as payment status.
// Leases tolerate deploy overlap; a crash can repeat a send, never lose it.
export function createNotificationWorker({ storage, dispatcher, now = Date.now, logger = console }) {
  let timer = null;
  let running = false;
  let cycle = null;

  async function deliver() {
    for (let n = 0; running && n < 20; n++) {
      const token = randomUUID();
      const payment = await storage.notifications.claim(now(), now() + 90000, token);
      if (!payment) return;
      const attempts = payment.notification_attempts + 1;
      try {
        let prepared = payment.notification_request ? JSON.parse(payment.notification_request) : null;
        if (!prepared) {
          prepared = await dispatcher.prepareRequest(payment, payment.status);
          if (prepared && !await storage.notifications.saveRequest(payment.id, token, JSON.stringify(prepared))) continue;
        }
        const result = prepared
          ? await dispatcher.dispatchOnce(payment, { event: payment.status, prepared, attempt: attempts })
          : { sent: false, success: true };
        await storage.notifications.finish(payment.id, token, {
          state: result.success ? 'success' : attempts >= MAX_ATTEMPTS ? 'failed_permanent' : 'pending',
          attempts, nextAt: now() + backoffDelayMs(attempts),
        });
      } catch (err) {
        // Keep the durable obligation. If finishing also fails, the lease
        // expires and another worker resumes it after storage recovers.
        logger.error('[NotificationWorker] Delivery failed:', err.message);
        await storage.notifications.finish(payment.id, token, {
          state: 'pending', attempts: payment.notification_attempts,
          nextAt: now() + 5000,
        });
      }
    }
  }

  function wake() {
    if (!running || cycle) return cycle;
    cycle = Promise.allSettled(Array.from({ length: 4 }, () => deliver()))
      .then((results) => {
        for (const result of results) if (result.status === 'rejected')
          logger.error('[NotificationWorker] Queue unavailable:', result.reason?.message);
      })
      .finally(() => { cycle = null; });
    return cycle;
  }

  return {
    start() {
      if (running) return cycle;
      running = true;
      timer = setInterval(wake, 1000);
      return wake();
    },
    wake,
    async stop() {
      running = false;
      clearInterval(timer);
      await cycle;
    },
  };
}
