import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ChatHistoryMessage, RagSearchResult } from '../../../types/chat.types';
import { buildSystemPrompt, formatContextBlock } from './system.prompt';

const MAX_HISTORY_TURNS = 10;

export function buildChatCompletionMessages(params: {
  userMessage: string;
  history: ChatHistoryMessage[];
  contextChunks: RagSearchResult[];
}): ChatCompletionMessageParam[] {
  const system = buildSystemPrompt();
  const contextBlock = formatContextBlock(params.contextChunks);

  const trimmedHistory = params.history.slice(-MAX_HISTORY_TURNS);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...trimmedHistory.map(
      (msg): ChatCompletionMessageParam =>
        msg.role === 'user'
          ? { role: 'user', content: msg.content }
          : { role: 'assistant', content: msg.content }
    ),
    {
      role: 'user',
      content: `Context from Sit With PD knowledge base:
${contextBlock}

User question:
${params.userMessage.trim()}`,
    },
  ];

  return messages;
}
