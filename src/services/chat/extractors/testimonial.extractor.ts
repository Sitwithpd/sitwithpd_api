import { ChatKnowledgeSourceType } from '@prisma/client';
import prisma from '../../../config/prisma';
import { CHAT_FRONTEND_PATHS } from '../../../config/chat';
import { KnowledgeDocumentChunk } from '../../../types/chat.types';

export async function extractTestimonialChunks(testimonialId: string): Promise<KnowledgeDocumentChunk[]> {
  const testimonial = await prisma.testimonial.findFirst({
    where: { id: testimonialId, isPublished: true },
    include: { camp: { select: { id: true, title: true } } },
  });

  if (!testimonial) return [];

  const path = testimonial.camp
    ? CHAT_FRONTEND_PATHS.campDetail(testimonial.camp.id)
    : CHAT_FRONTEND_PATHS.programs;

  const text = [
    `Testimonial from ${testimonial.name}`,
    testimonial.role ? `Role: ${testimonial.role}` : null,
    testimonial.camp ? `Related camp: ${testimonial.camp.title}` : 'Site-wide testimonial',
    '',
    `"${testimonial.quote}"`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    {
      sourceType: ChatKnowledgeSourceType.TESTIMONIAL,
      sourceId: testimonial.id,
      chunkIndex: 0,
      title: `Testimonial — ${testimonial.name}`,
      path,
      text,
    },
  ];
}

export async function extractAllTestimonialChunks(): Promise<KnowledgeDocumentChunk[]> {
  const rows = await prisma.testimonial.findMany({
    where: { isPublished: true },
    select: { id: true },
    orderBy: { order: 'asc' },
  });

  const all: KnowledgeDocumentChunk[] = [];
  for (const { id } of rows) {
    all.push(...(await extractTestimonialChunks(id)));
  }
  return all;
}
