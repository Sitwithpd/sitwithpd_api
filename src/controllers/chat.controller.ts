import { Response } from 'express';
import { ChatMessageRole, Prisma } from '@prisma/client';
import {
  CHAT_DISCLAIMER_FULL,
  CHAT_DISCLAIMER_SHORT,
  CHAT_FRONTEND_PATHS,
  CHAT_INTRO,
  CHAT_SUGGESTED_PROMPTS,
  getChatMaxMessagesPerSession,
  isChatStreamingEnabled,
} from '../config/chat';
import {
  appendChatMessage,
  assertChatSessionAccess,
  attachUserToChatSession,
  countSessionUserMessages,
  createChatSession,
  getChatGuestTokenCookieName,
  getChatSessionHistory,
  getChatSessionIdCookieName,
  listChatSessionMessages,
  setChatSessionCookies,
} from '../lib/chatSessionCookie';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { ChatRequest } from '../middleware/chat.middleware';
import {
  processChatMessage,
  processChatMessageStream,
} from '../services/chat/chatOrchestrator.service';
import { ChatOrchestratorResult } from '../types/chat.types';

const MAX_MESSAGE_LENGTH = 2000;

function wantsStream(req: ChatRequest, bodyStream?: boolean): boolean {
  if (!isChatStreamingEnabled()) return false;
  if (bodyStream === true) return true;
  const accept = req.get('Accept') || '';
  return accept.includes('text/event-stream');
}

function formatMessageForApi(row: {
  id: string;
  role: ChatMessageRole;
  content: string;
  metadata: unknown;
  createdAt: Date;
}) {
  const metadata = row.metadata as Record<string, unknown> | null;
  const links = Array.isArray(metadata?.links) ? metadata.links : undefined;
  const sources = Array.isArray(metadata?.sources) ? metadata.sources : undefined;

  return {
    id: row.id,
    role: row.role.toLowerCase(),
    content: row.content,
    links,
    sources,
    createdAt: row.createdAt,
  };
}

function buildAssistantMetadata(result: ChatOrchestratorResult): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      ...result.metadata,
      links: result.links,
    })
  ) as Prisma.InputJsonValue;
}

function formatReply(result: ChatOrchestratorResult, assistantMessageId: string) {
  return {
    id: assistantMessageId,
    content: result.content,
    links: result.links,
    sources: result.sources,
    requiresAuth: result.requiresAuth ?? false,
    loginPath: result.loginPath ?? null,
    metadata: result.metadata,
  };
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** GET /api/chat/config */
export const getChatConfig = catchAsync(async (_req: ChatRequest, res: Response) => {
  res.json({
    success: true,
    message: 'Chat config retrieved.',
    data: {
      intro: CHAT_INTRO,
      disclaimerShort: CHAT_DISCLAIMER_SHORT,
      disclaimerFull: CHAT_DISCLAIMER_FULL,
      suggestedPrompts: [...CHAT_SUGGESTED_PROMPTS],
      streamingEnabled: isChatStreamingEnabled(),
      loginPath: CHAT_FRONTEND_PATHS.login,
    },
  });
});

/** POST /api/chat/sessions */
export const createChatSessionHandler = catchAsync(async (req: ChatRequest, res: Response) => {
  const userId = req.user?.id ?? null;
  const { session, guestToken } = await createChatSession(userId);

  setChatSessionCookies(res, session.id, guestToken, req.hostname);

  res.status(201).json({
    success: true,
    message: 'Chat session created.',
    data: {
      sessionId: session.id,
      expiresAt: session.expiresAt,
    },
  });
});

/** GET /api/chat/sessions/:sessionId */
export const getChatSessionHandler = catchAsync(async (req: ChatRequest, res: Response) => {
  const sessionId = req.chatSession!.id;
  const messages = await listChatSessionMessages(sessionId);

  res.json({
    success: true,
    message: 'Chat session retrieved.',
    data: {
      sessionId,
      messages: messages.map(formatMessageForApi),
    },
  });
});

/** POST /api/chat/sessions/:sessionId/messages */
export const postChatMessageHandler = catchAsync(async (req: ChatRequest, res: Response) => {
  const sessionId = req.chatSession!.id;
  const { message, stream: bodyStream } = req.body as {
    message?: string;
    stream?: boolean;
  };

  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (!trimmed) throw new AppError('Message is required.', 400);
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new AppError(`Message must be at most ${MAX_MESSAGE_LENGTH} characters.`, 400);
  }

  if (req.user?.id) {
    await attachUserToChatSession(sessionId, req.user.id);
  }

  const userMessageCount = await countSessionUserMessages(sessionId);
  if (userMessageCount >= getChatMaxMessagesPerSession()) {
    throw new AppError('This conversation has reached its message limit. Please start a new session.', 429);
  }

  await appendChatMessage({
    sessionId,
    role: ChatMessageRole.USER,
    content: trimmed,
  });

  const history = await getChatSessionHistory(sessionId);
  const historyWithoutLatest = history.slice(0, -1);

  const orchestratorParams = {
    sessionId,
    userMessage: trimmed,
    history: historyWithoutLatest,
    isAuthenticated: Boolean(req.user?.id),
  };

  if (wantsStream(req, bodyStream)) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as Response & { flushHeaders: () => void }).flushHeaders();
    }

    try {
      let finalResult: ChatOrchestratorResult | undefined;

      for await (const event of processChatMessageStream(orchestratorParams)) {
        if (event.type === 'token') {
          writeSse(res, 'token', { delta: event.delta });
        } else {
          finalResult = event.result;
        }
      }

      if (!finalResult) {
        throw new Error('Stream ended without a completion event.');
      }

      const assistantRow = await appendChatMessage({
        sessionId,
        role: ChatMessageRole.ASSISTANT,
        content: finalResult.content,
        metadata: buildAssistantMetadata(finalResult),
      });

      writeSse(res, 'done', {
        reply: formatReply(finalResult, assistantRow.id),
      });
      res.end();
    } catch (err) {
      writeSse(res, 'error', {
        message: err instanceof Error ? err.message : 'Chat stream failed.',
      });
      res.end();
    }
    return;
  }

  const result = await processChatMessage(orchestratorParams);

  const assistantRow = await appendChatMessage({
    sessionId,
    role: ChatMessageRole.ASSISTANT,
    content: result.content,
    metadata: buildAssistantMetadata(result),
  });

  res.json({
    success: true,
    message: 'Reply generated.',
    data: {
      reply: formatReply(result, assistantRow.id),
    },
  });
});

/** Export cookie names for middleware/tests */
export { getChatSessionIdCookieName, getChatGuestTokenCookieName, assertChatSessionAccess };
