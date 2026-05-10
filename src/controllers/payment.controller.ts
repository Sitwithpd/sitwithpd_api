import { Request, Response } from 'express';
import crypto from 'crypto';
import { CampRegistrationStatus } from '@prisma/client';
import prisma from '../config/prisma';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest, PaystackEvent } from '../types';
import {
  sendProgramPurchaseEmail,
  sendCampRegistrationEmail,
  sendConsultationBookingEmail,
} from '../utils/email.service';
import { isRegistrationPayable } from '../services/campInventory.service';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const PAYSTACK_BASE = 'https://api.paystack.co';

// ── Helper: Call Paystack API ─────────────────────────────────────────────────
const paystackRequest = async (endpoint: string, method = 'GET', body?: object) => {
  const res = await fetch(`${PAYSTACK_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return res.json();
};

// ── Initialize Payment ────────────────────────────────────────────────────────
// POST /api/payments/initialize
// Body: { type: 'PROGRAM' | 'CAMP' | 'CONSULTATION', itemId: string }
// CAMP: amount comes from the registration's CampTier only.
export const initializePayment = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { type, itemId } = req.body;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found.', 404);

  let amount = 0;
  let description = '';

  // Determine amount based on payment type
  if (type === 'PROGRAM') {
    const program = await prisma.program.findUnique({ where: { id: itemId } });
    if (!program) throw new AppError('Program not found.', 404);

    // Check not already purchased
    const existing = await prisma.purchase.findUnique({
      where: { userId_programId: { userId, programId: itemId } },
    });
    if (existing) throw new AppError('You already own this program.', 400);

    amount = program.price;
    description = `Purchase: ${program.title}`;

  } else if (type === 'CAMP') {
    const registration = await prisma.campRegistration.findUnique({
      where: { id: itemId },
      include: { camp: true, tier: true, payment: true },
    });
    if (!registration) throw new AppError('Camp registration not found.', 404);
    if (registration.userId !== userId) throw new AppError('Unauthorized.', 403);

    if (!registration.tier) {
      throw new AppError(
        'Camp registration is missing tier pricing. Please contact support.',
        400
      );
    }

    // Lifecycle gate (Phase 5): refuse to start a Paystack session for any
    // registration that is not currently payable. This catches CONFIRMED,
    // EXPIRED, CANCELLED, and PENDING_PAYMENT past the 60-minute deadline.
    if (registration.status === CampRegistrationStatus.CONFIRMED) {
      throw new AppError('You have already paid for this application.', 400);
    }
    if (!isRegistrationPayable(registration)) {
      throw new AppError(
        'This application has expired. Please re-apply to obtain a new payment window.',
        400
      );
    }

    // Stale-payment cleanup: free the Payment.campRegistrationId @unique slot so
    // the new Payment row created below can attach. Mirrors the cleanup performed
    // by camp.controller.ts on the reset path; this branch additionally handles
    // the double-click case where a user clicks "Pay" twice on the same active
    // registration before the first session is finalised.
    if (registration.payment) {
      if (registration.payment.status === 'SUCCESS') {
        throw new AppError('You have already paid for this application.', 400);
      }
      await prisma.payment.update({
        where: { id: registration.payment.id },
        data: {
          campRegistrationId: null,
          ...(registration.payment.status === 'PENDING' ? { status: 'FAILED' as const } : {}),
        },
      });
    }

    amount = registration.tier.price;
    description = `Camp Application: ${registration.camp.title} — ${registration.tier.label}`;

  } else if (type === 'CONSULTATION') {
    const consultation = await prisma.consultation.findUnique({
      where: { id: itemId },
      include: { service: true },
    });
    if (!consultation) throw new AppError('Consultation not found.', 404);
    if (consultation.userId !== userId) throw new AppError('Unauthorized.', 403);

    amount = consultation.service.price;
    description = `Consultation: ${consultation.service.title}`;
  }

  // Paystack expects amount in kobo (multiply by 100)
  const paystackResponse = (await paystackRequest('/transaction/initialize', 'POST', {
    email: user.email,
    amount: amount * 100,
    metadata: { userId, type, itemId },
    callback_url: `${process.env.CLIENT_URL}/payment/verify`,
  })) as { status: boolean; data: { reference: string; authorization_url: string } };

  if (!paystackResponse.status) {
    throw new AppError('Could not initialize payment. Please try again.', 500);
  }

  // Create a PENDING payment record
  await prisma.payment.create({
    data: {
      userId,
      type,
      amount,
      status: 'PENDING',
      paystackRef: paystackResponse.data.reference,
      ...(type === 'CAMP' && { campRegistrationId: itemId }),
      ...(type === 'CONSULTATION' && { consultationId: itemId }),
    },
  });

  res.json({
    success: true,
    message: 'Payment initialized.',
    data: {
      authorizationUrl: paystackResponse.data.authorization_url,
      reference: paystackResponse.data.reference,
      description,
    },
  });
});

// ── Paystack Webhook ──────────────────────────────────────────────────────────
// POST /api/payments/webhook
// Called by Paystack when payment status changes
export const paystackWebhook = async (req: Request, res: Response) => {
  // Raw body required — mounted with express.raw in app.ts (Paystack signs exact bytes)
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body), 'utf8');
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).json({ message: 'Invalid signature.' });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(raw.toString('utf8')) as PaystackEvent;
  } catch {
    return res.status(400).json({ message: 'Invalid JSON.' });
  }

  // 2. Only handle successful charges
  if (event.event !== 'charge.success') {
    return res.sendStatus(200);
  }

  const { reference, metadata } = event.data;
  const { userId, type, itemId } = metadata;

  try {
    // 3. Update payment record to SUCCESS
    const payment = await prisma.payment.update({
      where: { paystackRef: reference },
      data: { status: 'SUCCESS', paystackResponse: event.data as object },
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.sendStatus(200);

    // 4. Fulfill the purchase based on type
    if (type === 'PROGRAM') {
      // Create purchase record giving user access
      await prisma.purchase.create({
        data: { userId, programId: itemId, payment: { connect: { id: payment.id } } },
      });

      const program = await prisma.program.findUnique({ where: { id: itemId } });
      if (program) {
        await sendProgramPurchaseEmail(user.email, user.firstName, program.title);
      }

    } else if (type === 'CAMP') {
      const registration = await prisma.campRegistration.findUnique({
        where: { id: itemId },
        include: { camp: true },
      });

      if (!registration) {
        console.warn(
          `[paystack-webhook] CAMP charge.success: registration ${itemId} not found.`
        );
      } else if (registration.userId !== userId) {
        console.warn(
          `[paystack-webhook] CAMP charge.success: registration ${itemId} userId mismatch ` +
            `(reg=${registration.userId}, metadata=${userId}).`
        );
      } else if (registration.status === CampRegistrationStatus.CONFIRMED) {
        // Idempotent: already promoted, almost certainly a webhook retry.
      } else {
        // Time-of-truth for the payability check is when Paystack actually
        // charged the card, not when the webhook reached us. This is fairer
        // when delivery is delayed past the 60-minute hold but the charge
        // itself happened in time. Falls back to receipt time if absent.
        const paidAtRaw = (event.data as Record<string, unknown>).paid_at;
        const eventTime =
          typeof paidAtRaw === 'string' ? new Date(paidAtRaw) : new Date();

        if (isRegistrationPayable(registration, eventTime)) {
          // Atomic, race-safe promotion: only the call that finds the row in
          // PENDING_PAYMENT will flip it. Concurrent webhook deliveries see
          // count === 0 and skip the email.
          const promoted = await prisma.campRegistration.updateMany({
            where: { id: registration.id, status: CampRegistrationStatus.PENDING_PAYMENT },
            data: { status: CampRegistrationStatus.CONFIRMED, paymentExpiresAt: null },
          });
          if (promoted.count === 1) {
            await sendCampRegistrationEmail(
              user.email,
              user.firstName,
              registration.camp.title,
              registration.camp.startDate
            );
          }
        } else {
          // Charge succeeded after the registration's hold elapsed. Money was
          // taken — flag for a manual refund and DO NOT confirm the seat.
          // Two channels until a Payment.refundRequired column exists:
          //   1. Marker inside Payment.paystackResponse for admin queries.
          //   2. Structured console.error for Render log alerting.
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              paystackResponse: {
                ...(event.data as object),
                _refundRequired: true,
                _refundReason:
                  'Registration expired before charge.success arrived.',
              } as object,
            },
          });
          console.error(
            '[paystack-webhook] CAMP refund-required: charge.success arrived for non-payable registration.',
            JSON.stringify({
              paymentId: payment.id,
              paystackRef: reference,
              registrationId: registration.id,
              userId,
              registrationStatus: registration.status,
              registrationExpiresAt: registration.paymentExpiresAt,
              eventTime: eventTime.toISOString(),
            })
          );
        }
      }

    } else if (type === 'CONSULTATION') {
      const consultation = await prisma.consultation.findUnique({
        where: { id: itemId },
        include: { service: true },
      });
      if (
        consultation &&
        (consultation.status === 'PENDING_PAYMENT' || consultation.status === 'PENDING')
      ) {
        await prisma.consultation.update({
          where: { id: consultation.id },
          data: { status: 'CONFIRMED' },
        });
        await sendConsultationBookingEmail(
          user.email,
          user.firstName,
          consultation.service.title,
          consultation.confirmedDate ?? consultation.preferredDate ?? undefined
        );
      }
    }

  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  res.sendStatus(200);
};

// ── Verify Payment (frontend callback) ───────────────────────────────────────
// GET /api/payments/verify/:reference
export const verifyPayment = catchAsync(async (req: Request, res: Response) => {
  const { reference } = req.params;

  const payment = await prisma.payment.findUnique({
    where: { paystackRef: reference },
  });

  if (!payment) throw new AppError('Payment record not found.', 404);

  res.json({
    success: true,
    message: 'Payment status fetched.',
    data: { status: payment.status, type: payment.type, amount: payment.amount },
  });
});

// ── Admin: All Payments ───────────────────────────────────────────────────────
// GET /api/admin/payments
export const getAllPayments = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count(),
  ]);

  res.json({
    success: true,
    message: 'Payments fetched.',
    data: payments,
    meta: buildMeta(total, page, limit),
  });
});
