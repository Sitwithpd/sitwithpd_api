import { Prisma, CampRegistrationStatus } from '@prisma/client';
import prisma from '../config/prisma';

/**
 * Single source of truth for camp registration inventory + lifecycle rules.
 *
 * Consumed by:
 *   - camp.controller     (registerForCamp + public seat counts)
 *   - payment.controller  (initialize + Paystack webhook for type=CAMP)
 *   - campRegistrationExpiry.service (Phase 6)
 *   - dashboard / admin   (read endpoints)
 *
 * This file imports only @prisma/client and the prisma singleton; nothing else
 * imports back into it, so the dependency graph stays one-directional.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a freshly-created PENDING_PAYMENT registration holds its seat
 * before the expiry worker releases it. Aligns with the user-facing
 * "complete payment within 60 minutes" copy and matches the consultation flow.
 */
export const CAMP_PAYMENT_HOLD_MS = 60 * 60 * 1000;

export function computePaymentExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + CAMP_PAYMENT_HOLD_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Where-clause builders (use inside controllers / transactions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows that currently consume camp / tier inventory:
 *   - CONFIRMED                                          → fully paid
 *   - PENDING_PAYMENT with paymentExpiresAt in the future → active hold
 *
 * A null paymentExpiresAt on a PENDING_PAYMENT row is defensively treated as
 * still holding (shouldn't occur because /register always sets it; the expiry
 * worker also normalizes). EXPIRED and CANCELLED never consume inventory.
 */
function holdingInventoryFilter(now: Date): Prisma.CampRegistrationWhereInput {
  return {
    OR: [
      { status: CampRegistrationStatus.CONFIRMED },
      {
        status: CampRegistrationStatus.PENDING_PAYMENT,
        OR: [
          { paymentExpiresAt: null },
          { paymentExpiresAt: { gt: now } },
        ],
      },
    ],
  };
}

export function whereCountsTowardCampInventory(
  campId: string,
  now: Date = new Date()
): Prisma.CampRegistrationWhereInput {
  return { campId, ...holdingInventoryFilter(now) };
}

export function whereCountsTowardTierInventory(
  tierId: string,
  now: Date = new Date()
): Prisma.CampRegistrationWhereInput {
  return { tierId, ...holdingInventoryFilter(now) };
}

/**
 * Used by the expiry worker (Phase 6): PENDING_PAYMENT rows whose deadline
 * has elapsed. Rows with a null deadline are not auto-expired here; they
 * indicate a data anomaly and should be inspected manually.
 */
export function whereExpiredHoldCandidates(
  now: Date = new Date()
): Prisma.CampRegistrationWhereInput {
  return {
    status: CampRegistrationStatus.PENDING_PAYMENT,
    paymentExpiresAt: { lt: now },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience aggregations (read endpoints; not for use inside transactions —
// pass the where-clause builders into the transaction client directly there)
// ─────────────────────────────────────────────────────────────────────────────

/** Total seats currently held for a camp (sum of participantCount on holding rows). */
export async function getSeatsTaken(
  campId: string,
  now: Date = new Date()
): Promise<number> {
  const agg = await prisma.campRegistration.aggregate({
    where: whereCountsTowardCampInventory(campId, now),
    _sum: { participantCount: true },
  });
  return agg._sum.participantCount ?? 0;
}

/** How many units of a specific tier are currently held (one row = one unit). */
export async function getTierUnitsHeld(
  tierId: string,
  now: Date = new Date()
): Promise<number> {
  return prisma.campRegistration.count({
    where: whereCountsTowardTierInventory(tierId, now),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure predicates (no DB) — work on any object that has the lifecycle fields
// ─────────────────────────────────────────────────────────────────────────────

type RegistrationLifecycleFields = {
  status: CampRegistrationStatus;
  paymentExpiresAt: Date | null;
};

/**
 * True when the registration can still complete checkout. Used by:
 *   - POST /api/payments/initialize (CAMP) before talking to Paystack.
 *   - The Paystack webhook before promoting status to CONFIRMED.
 *
 * Strict by design: requires PENDING_PAYMENT with a deadline in the future.
 * A null deadline is treated as not payable so the webhook can route those
 * to the manual refund queue rather than silently confirming.
 */
export function isRegistrationPayable(
  reg: RegistrationLifecycleFields,
  at: Date = new Date()
): boolean {
  if (reg.status !== CampRegistrationStatus.PENDING_PAYMENT) return false;
  if (reg.paymentExpiresAt == null) return false;
  return reg.paymentExpiresAt.getTime() > at.getTime();
}

/**
 * True when the row currently consumes a seat (CONFIRMED, or PENDING_PAYMENT
 * within its hold window). Mirrors `holdingInventoryFilter` for in-memory checks.
 */
export function isRegistrationActiveHold(
  reg: RegistrationLifecycleFields,
  at: Date = new Date()
): boolean {
  if (reg.status === CampRegistrationStatus.CONFIRMED) return true;
  if (reg.status !== CampRegistrationStatus.PENDING_PAYMENT) return false;
  if (reg.paymentExpiresAt == null) return true;
  return reg.paymentExpiresAt.getTime() > at.getTime();
}

/**
 * True when /api/camps/:id/register is allowed to reuse this row (reset back
 * to PENDING_PAYMENT). False for active holds and for CONFIRMED rows
 * (which should respond with "already applied").
 */
export function canReuseRegistrationRow(
  reg: RegistrationLifecycleFields,
  at: Date = new Date()
): boolean {
  if (reg.status === CampRegistrationStatus.EXPIRED) return true;
  if (reg.status === CampRegistrationStatus.CANCELLED) return true;
  if (reg.status === CampRegistrationStatus.PENDING_PAYMENT) {
    if (reg.paymentExpiresAt == null) return false;
    return reg.paymentExpiresAt.getTime() <= at.getTime();
  }
  return false;
}
