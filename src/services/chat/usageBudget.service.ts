import prisma from '../../config/prisma';
import { getChatMonthlyBudgetUsd } from '../../config/chat';
import { AppError } from '../../middleware/error.middleware';

function monthStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export async function getMonthToDateChatSpendUsd(): Promise<number> {
  const start = monthStartUtc();
  const aggregate = await prisma.chatUsageLog.aggregate({
    where: { createdAt: { gte: start } },
    _sum: { estimatedCostUsd: true },
  });
  return aggregate._sum.estimatedCostUsd ?? 0;
}

/** Throws 503 when monthly AI budget is configured and exceeded. */
export async function assertWithinMonthlyChatBudget(): Promise<void> {
  const cap = getChatMonthlyBudgetUsd();
  if (cap === undefined) return;

  const spent = await getMonthToDateChatSpendUsd();
  if (spent >= cap) {
    throw new AppError(
      'The assistant is temporarily unavailable due to usage limits. Please try again later or contact support.',
      503
    );
  }
}

export async function logChatUsage(params: {
  sessionId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}): Promise<void> {
  await prisma.chatUsageLog.create({
    data: {
      sessionId: params.sessionId ?? null,
      model: params.model,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      estimatedCostUsd: params.estimatedCostUsd,
    },
  });
}

export async function getChatUsageSummary(): Promise<{
  monthToDateUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
}> {
  const budgetUsd = getChatMonthlyBudgetUsd() ?? null;
  const monthToDateUsd = await getMonthToDateChatSpendUsd();
  const remainingUsd =
    budgetUsd != null ? Math.max(0, budgetUsd - monthToDateUsd) : null;

  return { monthToDateUsd, budgetUsd, remainingUsd };
}
