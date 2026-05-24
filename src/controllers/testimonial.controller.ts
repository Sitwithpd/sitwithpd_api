import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { mapForeignKeyDeleteError } from '../lib/prismaDeleteErrors';
import { buildMeta, parseAdminPagination } from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';
import {
  scheduleChatDeleteTestimonial,
  scheduleChatReindexTestimonial,
} from '../services/chat/chatReindexHook.service';

// GET /api/testimonials?campId=... — public listing (published only)
export const getTestimonials = catchAsync(async (req: Request, res: Response) => {
  const { campId } = req.query;

  const testimonials = await prisma.testimonial.findMany({
    where: {
      isPublished: true,
      ...(typeof campId === 'string' && campId.trim() !== '' && { campId }),
    },
    orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
  });

  res.json({ success: true, message: 'Testimonials fetched.', data: testimonials });
});

// GET /api/testimonials/admin/all — admin listing (all, including unpublished)
export const getTestimonialsAdmin = catchAsync(async (req: Request, res: Response) => {
  const { campId } = req.query;
  const { skip, page, limit } = parseAdminPagination(req);

  const where = {
    ...(typeof campId === 'string' && campId.trim() !== '' && { campId }),
  };

  const [testimonials, total] = await Promise.all([
    prisma.testimonial.findMany({
      where,
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.testimonial.count({ where }),
  ]);

  res.json({
    success: true,
    message: 'Testimonials fetched.',
    data: testimonials,
    meta: buildMeta(total, page, limit),
  });
});

// GET /api/testimonials/:id
export const getTestimonialById = catchAsync(async (req: Request, res: Response) => {
  const testimonial = await prisma.testimonial.findUnique({ where: { id: req.params.id } });
  if (!testimonial) throw new AppError('Testimonial not found.', 404);
  res.json({ success: true, message: 'Testimonial fetched.', data: testimonial });
});

// POST /api/testimonials — admin
export const createTestimonial = catchAsync(async (req: AuthRequest, res: Response) => {
  const { campId, name, role, quote, avatarUrl, isPublished, order } = req.body;

  if (!name || !quote) throw new AppError('name and quote are required.', 400);

  if (campId) {
    const camp = await prisma.camp.findUnique({ where: { id: campId } });
    if (!camp) throw new AppError('Camp not found.', 404);
  }

  // If uploaded via multipart, use the uploaded file path; otherwise use avatarUrl from body.
  const uploadedAvatar = (req.file as Express.Multer.File & { path?: string } | undefined)?.path;

  const testimonial = await prisma.testimonial.create({
    data: {
      campId: campId || null,
      name,
      role: role || null,
      quote,
      avatarUrl: uploadedAvatar || avatarUrl || null,
      isPublished: isPublished === undefined ? true : parseBoolean(isPublished),
      order: order ? parseInt(order) : 0,
    },
  });

  scheduleChatReindexTestimonial(testimonial.id);
  res.status(201).json({ success: true, message: 'Testimonial created.', data: testimonial });
});

// PATCH /api/testimonials/:id — admin
export const updateTestimonial = catchAsync(async (req: AuthRequest, res: Response) => {
  const { campId, name, role, quote, avatarUrl, isPublished, order } = req.body;

  const existing = await prisma.testimonial.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError('Testimonial not found.', 404);

  if (campId) {
    const camp = await prisma.camp.findUnique({ where: { id: campId } });
    if (!camp) throw new AppError('Camp not found.', 404);
  }

  const uploadedAvatar = (req.file as Express.Multer.File & { path?: string } | undefined)?.path;

  const testimonial = await prisma.testimonial.update({
    where: { id: req.params.id },
    data: {
      ...(campId !== undefined && { campId: campId || null }),
      ...(name && { name }),
      ...(role !== undefined && { role: role || null }),
      ...(quote && { quote }),
      ...(uploadedAvatar ? { avatarUrl: uploadedAvatar } : avatarUrl !== undefined && { avatarUrl: avatarUrl || null }),
      ...(isPublished !== undefined && { isPublished: parseBoolean(isPublished) }),
      ...(order !== undefined && { order: parseInt(order) }),
    },
  });

  scheduleChatReindexTestimonial(testimonial.id);
  res.json({ success: true, message: 'Testimonial updated.', data: testimonial });
});

// DELETE /api/testimonials/:id — admin
export const deleteTestimonial = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.testimonial.findUnique({ where: { id } });
  if (!existing) throw new AppError('Testimonial not found.', 404);
  try {
    await prisma.testimonial.delete({ where: { id } });
  } catch (e) {
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Testimonial not found.', 404);
    }
    throw e;
  }
  scheduleChatDeleteTestimonial(id);
  res.json({ success: true, message: 'Testimonial deleted.' });
});

function parseBoolean(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') return ['true', '1', 'yes', 'on'].includes(input.toLowerCase());
  return false;
}
