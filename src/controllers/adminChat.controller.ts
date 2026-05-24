import { Request, Response } from 'express';
import { ChatKnowledgeSourceType } from '@prisma/client';
import { isChatEnabled } from '../config/chat';
import { isOpenAIConfigured } from '../config/openai';
import { catchAsync, AppError } from '../middleware/error.middleware';
import {
  countKnowledgeChunks,
  getKnowledgeIndexLastUpdated,
  indexAllKnowledge,
  indexKnowledgeSource,
} from '../services/chat/knowledgeIndex.service';
import { getChatUsageSummary } from '../services/chat/usageBudget.service';

function parseSourceType(raw: unknown): ChatKnowledgeSourceType | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const value = String(raw).trim().toUpperCase();
  if (Object.values(ChatKnowledgeSourceType).includes(value as ChatKnowledgeSourceType)) {
    return value as ChatKnowledgeSourceType;
  }
  throw new AppError(
    `Invalid sourceType. Use one of: ${Object.values(ChatKnowledgeSourceType).join(', ')}.`,
    400
  );
}

/** POST /api/admin/chat/reindex — optional ?sourceType=PROGRAM|CAMP|... */
export const adminReindexChatKnowledge = catchAsync(async (req: Request, res: Response) => {
  const sourceType = parseSourceType(req.query.sourceType);

  if (sourceType) {
    const result = await indexKnowledgeSource(sourceType);
    return res.json({
      success: true,
      message: `Chat knowledge reindexed for ${sourceType}.`,
      data: result,
    });
  }

  const result = await indexAllKnowledge();
  res.json({
    success: true,
    message: 'Full chat knowledge index rebuilt.',
    data: result,
  });
});

/** GET /api/admin/chat/stats */
export const adminGetChatStats = catchAsync(async (_req: Request, res: Response) => {
  const [chunkCount, lastIndexedAt, usage] = await Promise.all([
    countKnowledgeChunks(),
    getKnowledgeIndexLastUpdated(),
    getChatUsageSummary(),
  ]);

  res.json({
    success: true,
    message: 'Chat stats retrieved.',
    data: {
      enabled: isChatEnabled(),
      openAiConfigured: isOpenAIConfigured(),
      chunkCount,
      lastIndexedAt,
      usage,
    },
  });
});

/** POST /api/internal/cron/chat-reindex — Bearer CRON_SECRET backup full rebuild */
export const cronReindexChatKnowledge = catchAsync(async (_req: Request, res: Response) => {
  const result = await indexAllKnowledge();
  res.json({
    success: true,
    message: 'Chat knowledge cron reindex completed.',
    data: result,
  });
});
