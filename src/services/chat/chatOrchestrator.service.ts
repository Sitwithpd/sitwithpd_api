import { CHAT_FRONTEND_PATHS } from '../../config/chat';
import {
  ChatHistoryMessage,
  ChatLink,
  ChatOrchestratorResult,
  ChatSourceCitation,
  ChatStreamEvent,
  RagSearchResult,
} from '../../types/chat.types';
import {
  completeChat,
  estimateChatCostUsd,
  streamChatCompletionWithUsage,
} from './chatCompletion.service';
import { buildChatCompletionMessages } from './prompts/buildMessages';
import { retrieveKnowledgeContext } from './rag.service';
import {
  buildSafetyOrchestratorMetadata,
  checkMessageSafety,
} from './safety.service';
import { assertWithinMonthlyChatBudget, logChatUsage } from './usageBudget.service';

export interface ProcessChatMessageParams {
  sessionId: string;
  userMessage: string;
  history: ChatHistoryMessage[];
  isAuthenticated: boolean;
}

function sourcesFromChunks(chunks: RagSearchResult[]): ChatSourceCitation[] {
  const seen = new Set<string>();
  const sources: ChatSourceCitation[] = [];

  for (const chunk of chunks) {
    const key = `${chunk.sourceType}:${chunk.sourceId}:${chunk.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      title: chunk.title,
      path: chunk.path,
      sourceType: chunk.sourceType,
    });
  }

  return sources;
}

function linksFromSources(sources: ChatSourceCitation[], extra: ChatLink[] = []): ChatLink[] {
  const seen = new Set<string>();
  const links: ChatLink[] = [];

  for (const link of [...extra, ...sources.map((s) => ({ label: s.title, path: s.path }))]) {
    if (seen.has(link.path)) continue;
    seen.add(link.path);
    links.push(link);
  }

  if (!seen.has(CHAT_FRONTEND_PATHS.contact)) {
    links.push({ label: 'Contact support', path: CHAT_FRONTEND_PATHS.contact });
  }

  return links.slice(0, 6);
}

function buildSafetyResult(
  safety: ReturnType<typeof checkMessageSafety>
): ChatOrchestratorResult {
  const content = safety.content ?? '';
  const links = safety.links ?? [];
  const metaFlags = buildSafetyOrchestratorMetadata(safety.kind);

  return {
    content,
    links,
    sources: [],
    requiresAuth: safety.requiresAuth,
    loginPath: safety.loginPath,
    metadata: {
      sources: [],
      model: 'safety-response',
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      ...metaFlags,
    },
  };
}

async function runLlmPipeline(params: {
  sessionId: string;
  userMessage: string;
  history: ChatHistoryMessage[];
}): Promise<{
  content: string;
  contextChunks: RagSearchResult[];
  usage: { model: string; promptTokens: number; completionTokens: number };
}> {
  const contextChunks = await retrieveKnowledgeContext(params.userMessage);
  const messages = buildChatCompletionMessages({
    userMessage: params.userMessage,
    history: params.history,
    contextChunks,
  });

  const completion = await completeChat(messages);

  return {
    content: completion.content,
    contextChunks,
    usage: completion.usage,
  };
}

function assembleResult(params: {
  content: string;
  contextChunks: RagSearchResult[];
  usage: { model: string; promptTokens: number; completionTokens: number };
  sessionId: string;
  extraLinks?: ChatLink[];
  requiresAuth?: boolean;
  loginPath?: string;
  metaFlags?: { crisis?: boolean; requiresAuth?: boolean };
}): ChatOrchestratorResult {
  const sources = sourcesFromChunks(params.contextChunks);
  const estimatedCostUsd = estimateChatCostUsd(
    params.usage.model,
    params.usage.promptTokens,
    params.usage.completionTokens
  );

  return {
    content: params.content,
    links: linksFromSources(sources, params.extraLinks),
    sources,
    requiresAuth: params.requiresAuth,
    loginPath: params.loginPath,
    metadata: {
      sources,
      model: params.usage.model,
      promptTokens: params.usage.promptTokens,
      completionTokens: params.usage.completionTokens,
      estimatedCostUsd,
      ...params.metaFlags,
    },
  };
}

async function persistUsage(sessionId: string, result: ChatOrchestratorResult): Promise<void> {
  if (result.metadata.estimatedCostUsd <= 0 && result.metadata.model === 'safety-response') {
    return;
  }

  await logChatUsage({
    sessionId,
    model: result.metadata.model,
    promptTokens: result.metadata.promptTokens,
    completionTokens: result.metadata.completionTokens,
    estimatedCostUsd: result.metadata.estimatedCostUsd,
  });
}

export async function processChatMessage(
  params: ProcessChatMessageParams
): Promise<ChatOrchestratorResult> {
  const trimmed = params.userMessage.trim();
  if (!trimmed) {
    throw new Error('Message cannot be empty.');
  }

  await assertWithinMonthlyChatBudget();

  const safety = checkMessageSafety(trimmed, { isAuthenticated: params.isAuthenticated });
  if (safety.kind !== 'none') {
    return buildSafetyResult(safety);
  }

  const { content, contextChunks, usage } = await runLlmPipeline({
    sessionId: params.sessionId,
    userMessage: trimmed,
    history: params.history,
  });

  const result = assembleResult({
    content,
    contextChunks,
    usage,
    sessionId: params.sessionId,
  });

  await persistUsage(params.sessionId, result);
  return result;
}

export async function* processChatMessageStream(
  params: ProcessChatMessageParams
): AsyncGenerator<ChatStreamEvent> {
  const trimmed = params.userMessage.trim();
  if (!trimmed) {
    throw new Error('Message cannot be empty.');
  }

  await assertWithinMonthlyChatBudget();

  const safety = checkMessageSafety(trimmed, { isAuthenticated: params.isAuthenticated });
  if (safety.kind !== 'none') {
    const result = buildSafetyResult(safety);
    yield { type: 'done', result };
    return;
  }

  const contextChunks = await retrieveKnowledgeContext(trimmed);
  const messages = buildChatCompletionMessages({
    userMessage: trimmed,
    history: params.history,
    contextChunks,
  });

  const { stream, getUsage } = await streamChatCompletionWithUsage(messages);

  let content = '';
  for await (const delta of stream) {
    content += delta;
    yield { type: 'token', delta };
  }

  const usage = await getUsage();
  const result = assembleResult({
    content: content.trim() || 'Sorry, I could not generate a response. Please try again or contact support.',
    contextChunks,
    usage,
    sessionId: params.sessionId,
  });

  await persistUsage(params.sessionId, result);
  yield { type: 'done', result };
}
