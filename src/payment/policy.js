// Stop displaying the QR at expires_at, but reserve the amount until provider
// transactions catch up. Terminal expiry is emitted only afterward.
export const RECONCILIATION_GRACE_MS = 120000;
export const reconciliationDeadline = (payment) => payment.expires_at + RECONCILIATION_GRACE_MS;
