import OpenAI from 'openai';
import { getOpenAiChatModel, getOpenAiEmbeddingModel, isChatEnabled } from './chat';

let client: OpenAI | undefined;

function getApiKey(): string | undefined {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

/** Lazy OpenAI client. Validates API key on first use when chat is enabled. */
export function getOpenAIClient(): OpenAI {
  if (client) return client;

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      isChatEnabled()
        ? 'OPENAI_API_KEY is not configured. Set it in the environment to use the chat feature.'
        : 'OPENAI_API_KEY is not configured.'
    );
  }

  client = new OpenAI({ apiKey });
  return client;
}

/** Whether an API key is present (does not validate with OpenAI). */
export function isOpenAIConfigured(): boolean {
  return Boolean(getApiKey());
}

export function resetOpenAIClientForTests(): void {
  client = undefined;
}

export { getOpenAiChatModel, getOpenAiEmbeddingModel };
