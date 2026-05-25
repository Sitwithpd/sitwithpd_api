import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../config/prisma';
import { ensurePlatformSettings } from '../services/platformSettings.service';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { sendEmailVerificationEmail, sendPasswordResetEmail } from '../utils/email.service';
import { getGoogleClientIds, verifyGoogleIdToken } from '../utils/googleAuth';
import { ACCESS_TOKEN_COOKIE, authCookieOptions, clearAuthCookie } from '../lib/authCookie';
import { isValidIanaTimezone } from '../lib/timezone';
import { AuthRequest } from '../types';

// ── Generate JWT ──────────────────────────────────────────────────────────────
const signToken = (id: string, email: string, role: string) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not defined');
  return jwt.sign({ id, email, role }, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  } as jwt.SignOptions);
};

const EMAIL_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;

const publicUserFields = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  isEmailVerified: true,
} as const;

/** Fields returned by GET/PATCH settings for the authenticated user (no password hash). */
const meResponseSelect = {
  ...publicUserFields,
  phone: true,
  timezone: true,
  notifyEmail: true,
  notifyProgramReminders: true,
  notifyPush: true,
  createdAt: true,
} as const;

// ── Register ──────────────────────────────────────────────────────────────────
export const register = catchAsync(async (req: Request, res: Response) => {
  const { firstName, lastName, email, password } = req.body;

  const settings = await ensurePlatformSettings();
  if (!settings.allowUserRegistration) {
    throw new AppError('New account registration is temporarily disabled.', 403);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError('Email already in use.', 400);

  const hashedPassword = await bcrypt.hash(password, 12);
  const verificationToken = crypto.randomBytes(32).toString('hex');
  const emailVerificationExpiry = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  const user = await prisma.user.create({
    data: {
      firstName,
      lastName,
      email,
      password: hashedPassword,
      emailVerificationToken: verificationToken,
      emailVerificationExpiry,
    },
    select: publicUserFields,
  });

  await sendEmailVerificationEmail(user.email, user.firstName, verificationToken);

  const token = signToken(user.id, user.email, user.role);
  res.cookie(ACCESS_TOKEN_COOKIE, token, authCookieOptions());

  res.status(201).json({
    success: true,
    message: 'Account created successfully. Please check your email to verify your address.',
    data: { user, token },
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────
export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new AppError('Invalid email or password.', 401);

  if (!user.password) {
    throw new AppError('Invalid email or password.', 401);
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new AppError('Invalid email or password.', 401);

  const token = signToken(user.id, user.email, user.role);
  res.cookie(ACCESS_TOKEN_COOKIE, token, authCookieOptions());

  res.json({
    success: true,
    message: 'Login successful.',
    data: {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
      },
      token,
    },
  });
});

// ── Google Sign-In (ID token from Google Identity Services / mobile SDK) ──────
export const googleAuth = catchAsync(async (req: Request, res: Response) => {
  if (getGoogleClientIds().length === 0) {
    throw new AppError('Google sign-in is not configured.', 503);
  }

  const { idToken } = req.body as { idToken?: string };
  let profile;
  try {
    profile = await verifyGoogleIdToken(idToken!);
  } catch {
    throw new AppError('Invalid or expired Google credential.', 401);
  }

  let user = await prisma.user.findUnique({
    where: { googleId: profile.googleId },
    select: publicUserFields,
  });

  if (!user) {
    const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
    if (byEmail) {
      if (byEmail.googleId && byEmail.googleId !== profile.googleId) {
        throw new AppError('This email is already linked to a different Google account.', 409);
      }
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: {
          googleId: profile.googleId,
          isEmailVerified: true,
        },
        select: publicUserFields,
      });
    } else {
      const plat = await ensurePlatformSettings();
      if (!plat.allowUserRegistration) {
        throw new AppError('New account registration is temporarily disabled.', 403);
      }

      user = await prisma.user.create({
        data: {
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          googleId: profile.googleId,
          isEmailVerified: true,
        },
        select: publicUserFields,
      });
    }
  }

  const token = signToken(user.id, user.email, user.role);
  res.cookie(ACCESS_TOKEN_COOKIE, token, authCookieOptions());

  res.json({
    success: true,
    message: 'Login successful.',
    data: {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
      },
      token,
    },
  });
});

// ── Verify email (link from email) ────────────────────────────────────────────
export const verifyEmail = catchAsync(async (req: Request, res: Response) => {
  const token = req.query.token as string;

  const found = await prisma.user.findFirst({
    where: {
      emailVerificationToken: token,
      emailVerificationExpiry: { gt: new Date() },
    },
    select: { id: true },
  });

  if (!found) throw new AppError('Verification link is invalid or has expired.', 400);

  const user = await prisma.user.update({
    where: { id: found.id },
    data: {
      isEmailVerified: true,
      emailVerificationToken: null,
      emailVerificationExpiry: null,
    },
    select: {
      ...publicUserFields,
      createdAt: true,
    },
  });

  res.json({ success: true, message: 'Email verified successfully.', data: user });
});

// ── Resend verification email (logged-in, unverified users) ───────────────────
export const resendVerification = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found.', 404);

  if (user.isEmailVerified) {
    return res.json({ success: true, message: 'Email is already verified.' });
  }

  const verificationToken = crypto.randomBytes(32).toString('hex');
  const emailVerificationExpiry = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerificationToken: verificationToken, emailVerificationExpiry },
  });

  await sendEmailVerificationEmail(user.email, user.firstName, verificationToken);

  res.json({ success: true, message: 'Verification email sent.' });
});

// ── Forgot Password ───────────────────────────────────────────────────────────
export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const { email } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });
  // Always return success to avoid email enumeration attacks
  if (!user) {
    return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  }

  if (!user.password) {
    return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetToken: resetToken, passwordResetExpiry: expiry },
  });

  await sendPasswordResetEmail(user.email, user.firstName, resetToken);

  res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
});

// ── Reset Password ────────────────────────────────────────────────────────────
export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { token, password } = req.body;

  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken: token,
      passwordResetExpiry: { gt: new Date() },
    },
  });

  if (!user) throw new AppError('Reset token is invalid or has expired.', 400);

  const hashedPassword = await bcrypt.hash(password, 12);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpiry: null,
    },
  });

  res.json({ success: true, message: 'Password reset successful. You can now log in.' });
});

// ── Logout — clear httpOnly auth cookie ───────────────────────────────────────
export const logout = catchAsync(async (_req: Request, res: Response) => {
  clearAuthCookie(res);
  res.json({ success: true, message: 'Logged out.' });
});

function toMeResponse<T extends { password: string | null }>(
  user: T
): Omit<T, 'password'> & { hasPassword: boolean } {
  const { password: pw, ...rest } = user;
  return { ...rest, hasPassword: !!pw };
}

// ── Get Current User (me) — includes Settings fields + hasPassword ────────────
export const getMe = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...meResponseSelect, password: true },
  });

  if (!user) throw new AppError('User not found.', 404);

  res.json({ success: true, message: 'User retrieved.', data: toMeResponse(user) });
});

/** PATCH profile: firstName, lastName, email, phone, timezone */
export const updateProfile = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { firstName, lastName, email, phone, timezone } = req.body as Record<string, unknown>;

  const hasPayload =
    firstName !== undefined ||
    lastName !== undefined ||
    email !== undefined ||
    phone !== undefined ||
    timezone !== undefined;

  if (!hasPayload) {
    throw new AppError('Provide at least one field to update.', 400);
  }

  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...meResponseSelect,
      password: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  });
  if (!current) throw new AppError('User not found.', 404);

  const data: Prisma.UserUpdateInput = {};
  let emailChanged = false;

  if (firstName !== undefined) {
    if (typeof firstName !== 'string' || !firstName.trim()) throw new AppError('First name cannot be empty.', 400);
    data.firstName = firstName.trim();
  }
  if (lastName !== undefined) {
    if (typeof lastName !== 'string' || !lastName.trim()) throw new AppError('Last name cannot be empty.', 400);
    data.lastName = lastName.trim();
  }

  if (phone !== undefined) {
    if (phone === null || phone === '') data.phone = null;
    else if (typeof phone === 'string') data.phone = phone.trim() || null;
    else throw new AppError('Invalid phone value.', 400);
  }

  if (timezone !== undefined) {
    if (timezone === null || timezone === '') data.timezone = null;
    else if (typeof timezone === 'string') {
      if (!isValidIanaTimezone(timezone)) throw new AppError('Invalid timezone.', 400);
      data.timezone = timezone;
    } else throw new AppError('Invalid timezone value.', 400);
  }

  if (email !== undefined) {
    if (typeof email !== 'string' || !email.trim()) throw new AppError('Email cannot be empty.', 400);
    const newEmail = email.trim().toLowerCase();
    if (newEmail !== current.email) {
      emailChanged = true;
      const taken = await prisma.user.findUnique({ where: { email: newEmail } });
      if (taken) throw new AppError('Email already in use.', 409);
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const emailVerificationExpiry = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
      data.email = newEmail;
      data.isEmailVerified = false;
      data.emailVerificationToken = verificationToken;
      data.emailVerificationExpiry = emailVerificationExpiry;
    }
  }

  if (Object.keys(data).length === 0) {
    const unchanged = await prisma.user.findUnique({
      where: { id: userId },
      select: { ...meResponseSelect, password: true },
    });
    if (!unchanged) throw new AppError('User not found.', 404);
    return res.json({
      success: true,
      message: 'No changes.',
      data: toMeResponse(unchanged),
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data,
  });

  const shouldSendVerification = emailChanged && data.emailVerificationToken;
  if (
    typeof email === 'string' &&
    shouldSendVerification &&
    typeof data.emailVerificationToken === 'string'
  ) {
    const fn =
      typeof firstName === 'string' && firstName.trim()
        ? firstName.trim()
        : typeof data.firstName === 'string'
          ? String(data.firstName)
          : current.firstName;
    await sendEmailVerificationEmail(email.trim().toLowerCase(), fn, data.emailVerificationToken);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...meResponseSelect, password: true },
  });
  if (!user) throw new AppError('User not found.', 404);

  if (emailChanged) {
    const token = signToken(user.id, user.email, user.role);
    res.cookie(ACCESS_TOKEN_COOKIE, token, authCookieOptions());
  }

  const message =
    emailChanged &&
    typeof data.emailVerificationToken === 'string' &&
    typeof email === 'string'
      ? 'Profile updated. Please verify your new email address.'
      : 'Profile updated.';

  res.json({ success: true, message, data: toMeResponse(user) });
});

/** PATCH password (not for Google-only accounts without a password) */
export const updatePassword = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };

  if (!currentPassword || !newPassword) {
    throw new AppError('Current password and new password are required.', 400);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('User not found.', 404);

  if (!user.password) {
    throw new AppError(
      'Password sign-in is not set for this account. Sign in with Google, or use Forgot password to add a password.',
      400
    );
  }

  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) throw new AppError('Current password is incorrect.', 401);

  const hashed = await bcrypt.hash(newPassword, 12);

  await prisma.user.update({
    where: { id: userId },
    data: {
      password: hashed,
      passwordResetToken: null,
      passwordResetExpiry: null,
    },
  });

  const refreshed = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...meResponseSelect, password: true },
  });
  if (!refreshed) throw new AppError('User not found.', 404);

  res.json({
    success: true,
    message: 'Password updated.',
    data: toMeResponse(refreshed),
  });
});

/** PATCH notification toggles — at least one boolean field required */
export const updateNotificationPreferences = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { notifyEmail, notifyProgramReminders, notifyPush } = req.body as Record<string, unknown>;

  const hasAny =
    notifyEmail !== undefined ||
    notifyProgramReminders !== undefined ||
    notifyPush !== undefined;

  if (!hasAny) {
    throw new AppError('Provide at least one notification preference.', 400);
  }

  const data: { notifyEmail?: boolean; notifyProgramReminders?: boolean; notifyPush?: boolean } = {};

  if (notifyEmail !== undefined) {
    if (typeof notifyEmail !== 'boolean') throw new AppError('notifyEmail must be a boolean.', 400);
    data.notifyEmail = notifyEmail;
  }
  if (notifyProgramReminders !== undefined) {
    if (typeof notifyProgramReminders !== 'boolean')
      throw new AppError('notifyProgramReminders must be a boolean.', 400);
    data.notifyProgramReminders = notifyProgramReminders;
  }
  if (notifyPush !== undefined) {
    if (typeof notifyPush !== 'boolean') throw new AppError('notifyPush must be a boolean.', 400);
    data.notifyPush = notifyPush;
  }

  await prisma.user.update({ where: { id: userId }, data });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...meResponseSelect, password: true },
  });
  if (!user) throw new AppError('User not found.', 404);

  res.json({
    success: true,
    message: 'Notification preferences updated.',
    data: toMeResponse(user),
  });
});
