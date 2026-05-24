import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { getOpenAIClient, getOpenAiChatModel } from '../../config/openai';

export interface ChatCompletionUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletionResult {
  content: string;
  usage: ChatCompletionUsage;
}

/** Rough USD estimate for chat models (adjust if OPENAI_CHAT_MODEL changes). */
export function estimateChatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const normalized = model.toLowerCase();
  let inputPerToken = 0.15 / 1_000_000;
  let outputPerToken = 0.6 / 1_000_000;

  if (normalized.includes('gpt-4o') && !normalized.includes('mini')) {
    inputPerToken = 2.5 / 1_000_000;
    outputPerToken = 10 / 1_000_000;
  }

  return promptTokens * inputPerToken + completionTokens * outputPerToken;
}

export async function completeChat(
  messages: ChatCompletionMessageParam[]
): Promise<ChatCompletionResult> {
  const client = getOpenAIClient();
  const model = getOpenAiChatModel();

  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content?.trim() ?? '';
  if (!content) {
    throw new Error('OpenAI returned an empty assistant message.');
  }

  return {
    content,
    usage: {
      model: response.model ?? model,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

export async function* streamChatCompletion(
  messages: ChatCompletionMessageParam[]
): AsyncGenerator<string> {
  const client = getOpenAIClient();
  const model = getOpenAiChatModel();

  const stream = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.3,
    stream: true,
    stream_options: { include_usage: true },
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export async function streamChatCompletionWithUsage(
  messages: ChatCompletionMessageParam[]
): Promise<{ stream: AsyncGenerator<string>; getUsage: () => Promise<ChatCompletionUsage> }> {
  const client = getOpenAIClient();
  const model = getOpenAiChatModel();

  const openaiStream = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.3,
    stream: true,
    stream_options: { include_usage: true },
  });

  let resolvedModel = model;
  let promptTokens = 0;
  let completionTokens = 0;

  async function* generator(): AsyncGenerator<string> {
    for await (const chunk of openaiStream) {
      if (chunk.usage) {
        resolvedModel = chunk.model ?? model;
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      }
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  return {
    stream: generator(),
    getUsage: async () => ({
      model: resolvedModel,
      promptTokens,
      completionTokens,
    }),
  };
}
