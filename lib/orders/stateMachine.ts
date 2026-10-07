// ============================================================================
// Order status state machine.
//
// WHY THIS FILE EXISTS: "لخبطة في الحجوزات" (order mix-ups) often comes from
// status updates applied out of order — e.g. a delayed webhook retry moving
// a refunded order back to "paid". This file is the single place that
// decides whether a status change is allowed; every place that updates an
// order's status (the webhook handler, admin actions, etc.) must go through
// `assertValidTransition()` instead of writing `status` directly.
// ============================================================================

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'fulfilled'
  | 'cancelled'
  | 'payment_failed'
  | 'refunded';

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['paid', 'payment_failed', 'cancelled'],
  paid: ['fulfilled', 'refunded'],
  payment_failed: ['pending_payment', 'cancelled'], // allow retrying payment
  fulfilled: ['refunded'],
  cancelled: [], // terminal
  refunded: [],  // terminal
};

export class InvalidOrderTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Cannot move order from "${from}" to "${to}" — not an allowed transition.`);
    this.name = 'InvalidOrderTransitionError';
  }
}

export function assertValidTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) return; // no-op transitions are harmless (e.g. a duplicate webhook retry)
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
}
