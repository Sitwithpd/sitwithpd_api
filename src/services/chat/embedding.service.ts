import { getOpenAIClient, getOpenAiEmbeddingModel } from '../../config/openai';

const MAX_BATCH_SIZE = 64;

function cleanInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot embed empty text.');
  }
  return trimmed.replace(/\0/g, '');
}

export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const client = getOpenAIClient();
  const model = getOpenAiEmbeddingModel();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE).map(cleanInput);
    const response = await client.embeddings.create({ model, input: batch });

    const ordered = response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((row) => row.embedding);

    if (ordered.length !== batch.length) {
      throw new Error('OpenAI embeddings response size mismatch.');
    }

    results.push(...ordered);
  }

  return results;
}

/** pgvector literal for raw SQL: `[0.1,0.2,...]` */
export function embeddingToVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
