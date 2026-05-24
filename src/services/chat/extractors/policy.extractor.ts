import fs from 'fs/promises';
import path from 'path';
import { ChatKnowledgeSourceType } from '@prisma/client';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';

export const POLICY_SOURCE_ID = 'platform-knowledge';

function platformKnowledgePath(): string {
  return path.join(process.cwd(), 'src', 'data', 'chatPlatformKnowledge.md');
}

/**
 * Split markdown on level-2 headings (`## Title`). Each section becomes one chunk.
 */
export function parsePolicyMarkdown(markdown: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string }> = [];
  const parts = markdown.split(/\r?\n(?=## )/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith('# Sit With PD')) continue;

    const match = trimmed.match(/^##\s+(.+?)(?:\r?\n([\s\S]*))?$/);
    if (!match) continue;

    const title = match[1].trim();
    const body = (match[2] ?? '').trim();
    if (!body) continue;

    sections.push({ title, body: `## ${title}\n\n${body}` });
  }

  return sections;
}

export async function extractPolicyChunks(): Promise<KnowledgeDocumentChunk[]> {
  const filePath = platformKnowledgePath();
  const markdown = await fs.readFile(filePath, 'utf8');
  const sections = parsePolicyMarkdown(markdown);

  return sections.map((section, chunkIndex) => ({
    sourceType: ChatKnowledgeSourceType.POLICY,
    sourceId: POLICY_SOURCE_ID,
    chunkIndex,
    title: section.title,
    path: CHAT_FRONTEND_PATHS.contact,
    text: section.body,
  }));
}
