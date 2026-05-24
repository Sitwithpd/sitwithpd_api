import { ChatKnowledgeSourceType } from '@prisma/client';
import prisma from '../../config/prisma';
import { getChatRagMinScore, getChatRagTopK } from '../../config/chat';
import { RagSearchResult } from '../../types/chat.types';
import { embedText, embeddingToVectorLiteral } from './embedding.service';

interface RawRagRow {
  id: string;
  sourceType: ChatKnowledgeSourceType;
  sourceId: string;
  title: string;
  path: string;
  text: string;
  distance: number;
}

/**
 * Vector similarity search over indexed knowledge chunks.
 * Uses pgvector cosine distance (`<=>`); lower distance = closer match.
 */
export async function searchKnowledge(query: string, topK?: number): Promise<RagSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = topK ?? getChatRagTopK();
  const queryEmbedding = await embedText(trimmed);
  const vector = embeddingToVectorLiteral(queryEmbedding);
  const minScore = getChatRagMinScore();

  const rows = await prisma.$queryRawUnsafe<RawRagRow[]>(
    `
    SELECT
      id,
      "sourceType",
      "sourceId",
      title,
      path,
      text,
      (embedding <=> $1::vector) AS distance
    FROM chat_knowledge_chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
    `,
    vector,
    limit
  );

  let filtered = rows;
  if (minScore !== undefined) {
    filtered = rows.filter((row) => row.distance <= minScore);
  }

  return dedupeBySource(filtered);
}

/** Keep the best-scoring chunk per source document to diversify context. */
function dedupeBySource(rows: RawRagRow[]): RagSearchResult[] {
  const best = new Map<string, RawRagRow>();

  for (const row of rows) {
    const key = `${row.sourceType}:${row.sourceId}`;
    const existing = best.get(key);
    if (!existing || row.distance < existing.distance) {
      best.set(key, row);
    }
  }

  return [...best.values()]
    .sort((a, b) => a.distance - b.distance)
    .map((row) => ({
      id: row.id,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      title: row.title,
      path: row.path,
      text: row.text,
      distance: Number(row.distance),
    }));
}

/**
 * Optional keyword supplement when vector index is empty or query is very short.
 * Searches chunk text/title with case-insensitive substring match.
 */
export async function searchKnowledgeKeywordFallback(
  query: string,
  take: number = 5
): Promise<RagSearchResult[]> {
  const term = query.trim();
  if (term.length < 3) return [];

  const rows = await prisma.chatKnowledgeChunk.findMany({
    where: {
      OR: [
        { title: { contains: term, mode: 'insensitive' } },
        { text: { contains: term, mode: 'insensitive' } },
      ],
    },
    take,
    orderBy: { updatedAt: 'desc' },
  });

  return rows.map((row) => ({
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    title: row.title,
    path: row.path,
    text: row.text,
    distance: 1,
  }));
}

/** Vector search with keyword fallback when vector returns nothing. */
export async function retrieveKnowledgeContext(query: string, topK?: number): Promise<RagSearchResult[]> {
  const vectorResults = await searchKnowledge(query, topK);
  if (vectorResults.length > 0) return vectorResults;
  return searchKnowledgeKeywordFallback(query, topK ?? getChatRagTopK());
}
