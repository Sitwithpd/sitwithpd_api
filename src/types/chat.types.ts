import { ChatKnowledgeSourceType } from '@prisma/client';

/** One embeddable unit produced by content extractors before indexing. */
export interface KnowledgeDocumentChunk {
  sourceType: ChatKnowledgeSourceType;
  sourceId: string;
  chunkIndex: number;
  title: string;
  path: string;
  text: string;
}

/** Result row from pgvector similarity search. */
export interface RagSearchResult {
  id: string;
  sourceType: ChatKnowledgeSourceType;
  sourceId: string;
  title: string;
  path: string;
  text: string;
  /** Cosine distance (pgvector `<=>`); lower is more similar. */
  distance: number;
}

export interface KnowledgeIndexStats {
  sourcesProcessed: number;
  chunksIndexed: number;
  chunksSkipped: number;
  chunksDeleted: number;
  embeddingsGenerated: number;
}

export interface KnowledgeIndexSourceResult extends KnowledgeIndexStats {
  sourceType: ChatKnowledgeSourceType;
  sourceId?: string;
}

export type ChatSafetyKind = 'none' | 'crisis' | 'account_personal';

export interface ChatLink {
  label: string;
  path: string;
}

export interface ChatSourceCitation {
  title: string;
  path: string;
  sourceType: ChatKnowledgeSourceType;
}

export interface ChatSafetyCheckResult {
  kind: ChatSafetyKind;
  content?: string;
  links?: ChatLink[];
  requiresAuth?: boolean;
  loginPath?: string;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReplyMetadata {
  sources: ChatSourceCitation[];
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  crisis?: boolean;
  requiresAuth?: boolean;
}

export interface ChatOrchestratorResult {
  content: string;
  links: ChatLink[];
  sources: ChatSourceCitation[];
  metadata: ChatReplyMetadata;
  requiresAuth?: boolean;
  loginPath?: string;
}

export type ChatStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'done'; result: ChatOrchestratorResult };
