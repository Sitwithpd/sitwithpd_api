import crypto from 'crypto';
import type { CookieOptions, Response } from 'express';
import { ChatMessageRole, Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { getChatSessionCookieName, getChatSessionMaxAgeMs } from '../config/chat';
import { AppError } from '../middleware/error.middleware';
import { ChatHistoryMessage } from '../types/chat.types';
import { buildHttpOnlyCookieOptions } from './cookieOptions';

const GUEST_TOKEN_COOKIE_SUFFIX = '_token';

export function getChatSessionIdCookieName(): string {
  return getChatSessionCookieName();
}

export function getChatGuestTokenCookieName(): string {
  return `${getChatSessionCookieName()}${GUEST_TOKEN_COOKIE_SUFFIX}`;
}

export function hashGuestToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateGuestToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function baseCookieOptions(requestHost?: string): CookieOptions {
  return buildHttpOnlyCookieOptions({
    requestHost,
    explicitDomain: process.env.CHAT_COOKIE_DOMAIN,
    explicitSecure: process.env.CHAT_COOKIE_SECURE,
    explicitSameSite: process.env.CHAT_COOKIE_SAMESITE,
    maxAge: getChatSessionMaxAgeMs(),
  });
}

export function setChatSessionCookies(
  res: Response,
  sessionId: string,
  guestToken: string,
  requestHost?: string
): void {
  const opts = baseCookieOptions(requestHost);
  res.cookie(getChatSessionIdCookieName(), sessionId, opts);
  res.cookie(getChatGuestTokenCookieName(), guestToken, opts);
}

export function clearChatSessionCookies(res: Response, requestHost?: string): void {
  const { maxAge: _m, ...base } = baseCookieOptions(requestHost);
  res.clearCookie(getChatSessionIdCookieName(), base);
  res.clearCookie(getChatGuestTokenCookieName(), base);
}

export async function createChatSession(userId?: string | null) {
  const guestToken = generateGuestToken();
  const expiresAt = new Date(Date.now() + getChatSessionMaxAgeMs());

  const session = await prisma.chatSession.create({
    data: {
      userId: userId ?? null,
      guestTokenHash: hashGuestToken(guestToken),
      expiresAt,
    },
  });

  return { session, guestToken };
}

export async function getChatSessionById(sessionId: string) {
  return prisma.chatSession.findUnique({ where: { id: sessionId } });
}

export async function assertChatSessionAccess(params: {
  sessionId: string;
  guestToken?: string;
  userId?: string;
}) {
  const session = await getChatSessionById(params.sessionId);
  if (!session) {
    throw new AppError('Chat session not found.', 404);
  }

  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
    throw new AppError('Chat session has expired. Please start a new conversation.', 401);
  }

  if (params.userId && session.userId && session.userId === params.userId) {
    return session;
  }

  if (params.userId && session.userId && session.userId !== params.userId) {
    throw new AppError('This chat session belongs to another account.', 403);
  }

  const guestToken = params.guestToken?.trim();
  if (!guestToken || !session.guestTokenHash) {
    throw new AppError('Chat session verification failed.', 401);
  }

  if (hashGuestToken(guestToken) !== session.guestTokenHash) {
    throw new AppError('Chat session verification failed.', 401);
  }

  return session;
}

export async function getChatSessionHistory(sessionId: string): Promise<ChatHistoryMessage[]> {
  const rows = await prisma.chatMessage.findMany({
    where: {
      sessionId,
      role: { in: [ChatMessageRole.USER, ChatMessageRole.ASSISTANT] },
    },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  return rows.map((row) => ({
    role: row.role === ChatMessageRole.USER ? 'user' : 'assistant',
    content: row.content,
  }));
}

export async function countSessionUserMessages(sessionId: string): Promise<number> {
  return prisma.chatMessage.count({
    where: { sessionId, role: ChatMessageRole.USER },
  });
}

export async function appendChatMessage(params: {
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.chatMessage.create({
    data: {
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      metadata: params.metadata ?? undefined,
    },
  });
}

export async function listChatSessionMessages(sessionId: string) {
  return prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      metadata: true,
      createdAt: true,
    },
  });
}

export async function attachUserToChatSession(sessionId: string, userId: string) {
  return prisma.chatSession.update({
    where: { id: sessionId },
    data: { userId },
  });
}
