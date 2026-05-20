import { Request, Response } from 'express';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { ensurePlatformSettings } from '../services/platformSettings.service';
import {
  CONTACT_ADMIN_SEARCH_MAX_LEN,
  CONTACT_FULL_NAME_MAX,
  CONTACT_MESSAGE_MAX,
  CONTACT_MESSAGE_MIN,
  CONTACT_PHONE_MAX,
  createContactSubmission,
  deleteContactSubmissionById,
  listContactSubmissionsAdmin,
} from '../services/contact.service';
import { sendContactFormEmail, sendContactFormAutoReplyEmail } from '../utils/email.service';

/** POST /api/contact — public Contact Us form */
export const submitContact = catchAsync(async (req: Request, res: Response) => {
  // Honeypot: bots fill hidden fields; pretend success without saving or emailing.
  const honeypot = req.body?.website ?? req.body?.company;
  if (typeof honeypot === 'string' && honeypot.trim().length > 0) {
    return res.status(201).json({
      success: true,
      message: "Thank you. We've received your message and will get back to you soon.",
    });
  }

  const fullName = String(req.body.fullName ?? '').trim();
  const email = String(req.body.email ?? '').trim();
  const phoneRaw = req.body.phone;
  const message = String(req.body.message ?? '').trim();
  const source = req.body.source;

  if (!fullName) throw new AppError('Full name is required.', 400);
  if (fullName.length > CONTACT_FULL_NAME_MAX) {
    throw new AppError(`Full name must be at most ${CONTACT_FULL_NAME_MAX} characters.`, 400);
  }
  if (!email) throw new AppError('Email is required.', 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('A valid email address is required.', 400);
  }
  if (phoneRaw !== undefined && phoneRaw !== null && phoneRaw !== '') {
    const phone = String(phoneRaw).trim();
    if (phone.length > CONTACT_PHONE_MAX) {
      throw new AppError(`Phone must be at most ${CONTACT_PHONE_MAX} characters.`, 400);
    }
  }
  if (!message) throw new AppError('Message is required.', 400);
  if (message.length < CONTACT_MESSAGE_MIN) {
    throw new AppError(`Message must be at least ${CONTACT_MESSAGE_MIN} characters.`, 400);
  }
  if (message.length > CONTACT_MESSAGE_MAX) {
    throw new AppError(`Message must be at most ${CONTACT_MESSAGE_MAX} characters.`, 400);
  }

  const settings = await ensurePlatformSettings();
  const supportTo = settings.supportEmail?.trim();
  if (!supportTo) {
    throw new AppError('Support email is not configured. Please try again later.', 503);
  }

  const phone =
    phoneRaw !== undefined && phoneRaw !== null && String(phoneRaw).trim()
      ? String(phoneRaw).trim()
      : null;

  const submission = await createContactSubmission({
    fullName,
    email,
    phone,
    message,
    source: typeof source === 'string' ? source : undefined,
  });

  await sendContactFormEmail({
    to: supportTo,
    fullName: submission.fullName,
    email: submission.email,
    phone: submission.phone,
    message: submission.message,
    submissionId: submission.id,
  });

  try {
    await sendContactFormAutoReplyEmail({
      to: submission.email,
      fullName: submission.fullName,
    });
  } catch (err) {
    console.warn('[contact] auto-reply failed:', err);
  }

  res.status(201).json({
    success: true,
    message: "Thank you. We've received your message and will get back to you soon.",
    data: { id: submission.id },
  });
});

/** GET /api/admin/contact-submissions */
export const adminListContactSubmissions = catchAsync(async (req: Request, res: Response) => {
  const { skip, page, limit } = parseAdminPagination(req);
  const rawSearch = req.query.search;
  const search =
    typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, CONTACT_ADMIN_SEARCH_MAX_LEN)
      : '';

  const { rows, total } = await listContactSubmissionsAdmin({ skip, take: limit, search });

  res.json({
    success: true,
    message: 'Contact submissions fetched.',
    data: rows,
    meta: buildMeta(total, page, limit),
  });
});

/** DELETE /api/admin/contact-submissions/:id */
export const adminDeleteContactSubmission = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const deleted = await deleteContactSubmissionById(id);
  if (!deleted) throw new AppError('Contact submission not found.', 404);

  res.json({
    success: true,
    message: 'Contact submission deleted.',
  });
});
