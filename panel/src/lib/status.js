// Shared styling for a payment's terminal/lifecycle status, used wherever a
// status chip is shown (Payments table, payment detail, Create result).
//
// Colour scheme: pending = blue (brand), paid = green, expired = red.

/**
 * Tailwind colour classes for a payment status chip. Pair with the `.gp-status`
 * component class (which adds the chip shape and uppercase styling).
 *
 * @param {string} status - 'pending' | 'paid' | 'expired'.
 * @returns {string}
 */
export function paymentStatusBadgeClass(status) {
  switch (status) {
    case 'paid':
      return 'bg-emerald-100 text-emerald-700';
    case 'expired':
      return 'bg-red-100 text-red-700';
    case 'pending':
    default:
      return 'bg-brand-50 text-brand-700';
  }
}

export function transactionStatusBadgeClass(status) {
  switch (status) {
    case 'SETTLEMENT':
    case 'CAPTURE':
      return 'bg-emerald-100 text-emerald-700';
    case 'REFUND':
      return 'bg-red-100 text-red-700';
    case 'PARTIAL_REFUND':
      return 'bg-amber-100 text-amber-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}
