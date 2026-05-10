-- Phase 1 of the camp registration lifecycle work.
--
-- Adds an explicit status + payment-hold deadline to camp_registrations so that:
--   * /api/camps/:id/register can hold a seat for 60 minutes (PENDING_PAYMENT),
--   * the Paystack webhook can promote rows to CONFIRMED,
--   * an expiry worker can release seats by setting EXPIRED,
--   * admins can mark CANCELLED.
--
-- The (userId, campId) unique constraint is intentionally retained: when a user
-- retries after expiry, the same row is reset back to PENDING_PAYMENT.

-- CreateEnum
CREATE TYPE "CampRegistrationStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- AlterTable: lifecycle columns + audit timestamp
ALTER TABLE "camp_registrations"
  ADD COLUMN "status"           "CampRegistrationStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  ADD COLUMN "paymentExpiresAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt"        TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill #1: any registration linked to a SUCCESS payment is treated as CONFIRMED.
UPDATE "camp_registrations" cr
SET "status" = 'CONFIRMED'
FROM "payments" p
WHERE p."campRegistrationId" = cr."id"
  AND p."status" = 'SUCCESS';

-- Backfill #2: legacy registrations without a SUCCESS payment release their seat
-- (status -> EXPIRED). They never paid, so they should not block inventory or
-- prevent the same user from registering again. The row stays so admins keep
-- audit history; the next /register call will reset it to PENDING_PAYMENT.
UPDATE "camp_registrations" cr
SET "status" = 'EXPIRED'
WHERE cr."status" = 'PENDING_PAYMENT'
  AND NOT EXISTS (
    SELECT 1
    FROM "payments" p
    WHERE p."campRegistrationId" = cr."id"
      AND p."status" = 'SUCCESS'
  );

-- CreateIndex: composite index for inventory queries (counts by camp + status).
CREATE INDEX "camp_registrations_campId_status_idx"
  ON "camp_registrations"("campId", "status");

-- CreateIndex: supports the expiry worker's scan of stale holds.
CREATE INDEX "camp_registrations_status_paymentExpiresAt_idx"
  ON "camp_registrations"("status", "paymentExpiresAt");
