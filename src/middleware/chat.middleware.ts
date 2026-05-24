import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { AuthRequest } from '../types';
import prisma from '../config/prisma';
import { ACCESS_TOKEN_COOKIE } from '../lib/authCookie';
import {
  getChatGuestTokenCookieName,
  getChatSessionIdCookieName,
} from '../lib/chatSessionCookie';
import { isChatEnabled } from '../config/chat';
import { ensurePlatformSettings } from '../services/platformSettings.service';
import { AppError } from './error.middleware';
import { assertChatSessionAccess } from '../lib/chatSessionCookie';

export interface ChatRequest extends AuthRequest {
  chatSession?: {
    id: string;
    userId: string | null;
  };
}

function getBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization || !authorization.startsWith('Bearer ')) return undefined;
  return authorization.split(' ')[1];
}

/** Attach req.user when a valid JWT is present; never rejects. */
export async function optionalAuthenticate(
  req: ChatRequest,
  _res: Response,
  next: NextFunction
) {
  try {
    const token =
      getBearerToken(req.headers.authorization) ?? req.cookies?.[ACCESS_TOKEN_COOKIE];

    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string;
      email: string;
      role: Role;
    };

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) return next();

    req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
    next();
  } catch {
    next();
  }
}

export async function assertChatFeatureAvailable(
  _req: ChatRequest,
  _res: Response,
  next: NextFunction
) {
  try {
    if (!isChatEnabled()) {
      throw new AppError('Chat is currently disabled.', 503);
    }

    const settings = await ensurePlatformSettings();
    if (settings.maintenanceMode) {
      throw new AppError('Chat is unavailable while the site is under maintenance.', 503);
    }

    next();
  } catch (err) {
    next(err);
  }
}

/** Ensures URL :sessionId matches cookies and loads req.chatSession. */
export async function requireChatSession(
  req: ChatRequest,
  _res: Response,
  next: NextFunction
) {
  try {
    const sessionIdParam = req.params.sessionId;
    const sessionIdCookie = req.cookies?.[getChatSessionIdCookieName()];
    const guestToken = req.cookies?.[getChatGuestTokenCookieName()];

    if (!sessionIdParam || typeof sessionIdParam !== 'string') {
      throw new AppError('Session id is required.', 400);
    }

    if (!sessionIdCookie || sessionIdCookie !== sessionIdParam) {
      throw new AppError('Chat session cookie mismatch.', 401);
    }

    const session = await assertChatSessionAccess({
      sessionId: sessionIdParam,
      guestToken: typeof guestToken === 'string' ? guestToken : undefined,
      userId: req.user?.id,
    });

    req.chatSession = { id: session.id, userId: session.userId };
    next();
  } catch (err) {
    next(err);
  }
}
