import { ChatKnowledgeSourceType } from '@prisma/client';
import prisma from '../../../config/prisma';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';
import { chunkPlainText } from '../chunkText.service';

export async function extractBlogChunks(postId: string): Promise<KnowledgeDocumentChunk[]> {
  const post = await prisma.blogPost.findFirst({
    where: { id: postId, isPublished: true },
  });

  if (!post) return [];

  const path = CHAT_FRONTEND_PATHS.blogPost(post.slug);
  const header = [
    `Blog: ${post.title}`,
    `Category: ${post.category}`,
    post.authorDisplayName ? `Author: ${post.authorDisplayName}` : null,
    `Read time: ${post.readTimeMinutes} min`,
    '',
    post.excerpt,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  const bodyChunks = chunkPlainText(post.body);
  if (bodyChunks.length === 0) {
    return [
      {
        sourceType: ChatKnowledgeSourceType.BLOG,
        sourceId: post.id,
        chunkIndex: 0,
        title: post.title,
        path,
        text: header,
      },
    ];
  }

  return bodyChunks.map((bodyPart, chunkIndex) => ({
    sourceType: ChatKnowledgeSourceType.BLOG,
    sourceId: post.id,
    chunkIndex,
    title: chunkIndex === 0 ? post.title : `${post.title} (part ${chunkIndex + 1})`,
    path,
    text: chunkIndex === 0 ? `${header}\n${bodyPart}` : bodyPart,
  }));
}

export async function extractAllBlogChunks(): Promise<KnowledgeDocumentChunk[]> {
  const posts = await prisma.blogPost.findMany({
    where: { isPublished: true },
    select: { id: true },
    orderBy: { publishedAt: 'desc' },
  });

  const all: KnowledgeDocumentChunk[] = [];
  for (const { id } of posts) {
    all.push(...(await extractBlogChunks(id)));
  }
  return all;
}
