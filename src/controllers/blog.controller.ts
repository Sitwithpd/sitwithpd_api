import { Request, Response } from 'express';
import { BlogCategory, Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { mapForeignKeyDeleteError } from '../lib/prismaDeleteErrors';
import {
  buildMeta,
  parseAdminPagination,
  parseOptionalListPagination,
} from '../lib/pagination';
import { catchAsync, AppError } from '../middleware/error.middleware';
import { AuthRequest } from '../types';

function parseBoolean(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') return ['true', '1', 'yes', 'on'].includes(input.toLowerCase());
  return false;
}

function parseBlogCategory(raw: unknown, required: boolean): BlogCategory | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new AppError('category is required.', 400);
    return undefined;
  }
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '_');
  const map: Record<string, BlogCategory> = {
    REFLECTION: BlogCategory.REFLECTION,
    WELLBEING: BlogCategory.WELLBEING,
    PERSONAL_GROWTH: BlogCategory.PERSONAL_GROWTH,
  };
  if (map[s]) return map[s];
  if (Object.values(BlogCategory).includes(s as BlogCategory)) return s as BlogCategory;
  throw new AppError(
    'category must be REFLECTION, WELLBEING, or PERSONAL_GROWTH.',
    400
  );
}

/** URL-safe slug from user / title input */
function normalizeSlug(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return s || 'post';
}

function getSearchString(req: Request): string {
  const raw = req.query.search ?? req.query.q;
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

function searchWhereForPublic(term: string): Prisma.BlogPostWhereInput {
  return {
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { excerpt: { contains: term, mode: 'insensitive' } },
    ],
  };
}

function searchWhereForAdmin(term: string): Prisma.BlogPostWhereInput {
  return {
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { excerpt: { contains: term, mode: 'insensitive' } },
      { slug: { contains: term, mode: 'insensitive' } },
    ],
  };
}

/**
 * `status` (admin list): all | draft | published
 */
function parseListStatus(raw: unknown): 'all' | 'draft' | 'published' {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'all';
  const s = String(raw).trim().toLowerCase();
  if (s === 'all') return 'all';
  if (s === 'draft' || s === 'drafts') return 'draft';
  if (s === 'published') return 'published';
  throw new AppError('status must be all, draft, or published.', 400);
}

// ── Public ───────────────────────────────────────────────────────────────────

export const getPublishedBlogPosts = catchAsync(async (req: Request, res: Response) => {
  const { category } = req.query;
  const searchTerm = getSearchString(req);

  const parts: Prisma.BlogPostWhereInput[] = [{ isPublished: true }];

  if (category !== undefined && category !== null && String(category).trim() !== '') {
    parts.push({ category: parseBlogCategory(category, true)! });
  }
  if (searchTerm) {
    parts.push(searchWhereForPublic(searchTerm));
  }

  const where: Prisma.BlogPostWhereInput = parts.length > 1 ? { AND: parts } : parts[0]!;

  const pag = parseOptionalListPagination(req);
  const orderBy: Prisma.BlogPostOrderByWithRelationInput[] = [
    { publishedAt: 'desc' },
    { createdAt: 'desc' },
  ];
  const select = {
    id: true,
    slug: true,
    title: true,
    excerpt: true,
    readTimeMinutes: true,
    category: true,
    coverImageUrl: true,
    publishedAt: true,
    createdAt: true,
  } as const;

  if (pag.mode === 'page') {
    const { skip, page, limit } = pag;
    const [total, posts] = await Promise.all([
      prisma.blogPost.count({ where }),
      prisma.blogPost.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select,
      }),
    ]);
    return res.json({
      success: true,
      message: 'Blog posts retrieved.',
      data: posts,
      meta: buildMeta(total, page, limit),
    });
  }

  const posts = await prisma.blogPost.findMany({
    where,
    orderBy,
    select,
  });

  res.json({ success: true, message: 'Blog posts retrieved.', data: posts });
});

export const getBlogPostBySlug = catchAsync(async (req: Request, res: Response) => {
  const { slug } = req.params;

  const post = await prisma.blogPost.findFirst({
    where: { slug, isPublished: true },
  });

  if (!post) throw new AppError('Blog post not found.', 404);

  res.json({ success: true, message: 'Blog post retrieved.', data: post });
});

// ── Admin ────────────────────────────────────────────────────────────────────

export const adminListBlogPosts = catchAsync(async (req: AuthRequest, res: Response) => {
  const { category } = req.query;
  const searchTerm = getSearchString(req);
  const listStatus = parseListStatus(req.query.status);

  const parts: Prisma.BlogPostWhereInput[] = [];

  if (listStatus === 'draft') {
    parts.push({ isPublished: false });
  } else if (listStatus === 'published') {
    parts.push({ isPublished: true });
  }

  if (category !== undefined && category !== null && String(category).trim() !== '') {
    parts.push({ category: parseBlogCategory(category, true)! });
  }
  if (searchTerm) {
    parts.push(searchWhereForAdmin(searchTerm));
  }

  const where: Prisma.BlogPostWhereInput =
    parts.length === 0 ? {} : parts.length === 1 ? parts[0]! : { AND: parts };

  const { skip, page, limit } = parseAdminPagination(req);
  const orderBy = { updatedAt: 'desc' as const };

  const [total, posts] = await Promise.all([
    prisma.blogPost.count({ where }),
    prisma.blogPost.findMany({
      where,
      orderBy,
      skip,
      take: limit,
    }),
  ]);

  res.json({
    success: true,
    message: 'Blog posts retrieved.',
    data: posts,
    meta: buildMeta(total, page, limit),
  });
});

export const getBlogPostByIdAdmin = catchAsync(async (req: AuthRequest, res: Response) => {
  const post = await prisma.blogPost.findUnique({ where: { id: req.params.id } });
  if (!post) throw new AppError('Blog post not found.', 404);

  res.json({ success: true, message: 'Blog post retrieved.', data: post });
});

export const createBlogPost = catchAsync(async (req: AuthRequest, res: Response) => {
  const { title, excerpt, body, slug: slugRaw, readTimeMinutes: rtm, isPublished, coverImageUrl } =
    req.body;

  const filePath = (req.file as Express.Multer.File & { path?: string })?.path;
  const coverFromFile = filePath ?? undefined;
  const coverFromBody =
    typeof coverImageUrl === 'string' && coverImageUrl.trim() ? coverImageUrl.trim() : undefined;
  const coverImage = coverFromFile ?? coverFromBody ?? null;

  if (!title || typeof title !== 'string') throw new AppError('title is required.', 400);
  if (!excerpt || typeof excerpt !== 'string') throw new AppError('excerpt is required.', 400);
  if (!body || typeof body !== 'string') throw new AppError('body is required.', 400);

  const category = parseBlogCategory(req.body.category, true)!;
  const slug = normalizeSlug(
    typeof slugRaw === 'string' && slugRaw.trim() ? slugRaw : title
  );

  let readTimeMinutes = 5;
  if (rtm !== undefined && rtm !== null && rtm !== '') {
    const n = parseInt(String(rtm), 10);
    if (Number.isNaN(n) || n < 1) {
      throw new AppError('readTimeMinutes must be a positive integer.', 400);
    }
    readTimeMinutes = n;
  }

  const published = parseBoolean(isPublished);
  const now = new Date();

  try {
    const post = await prisma.blogPost.create({
      data: {
        slug,
        title: title.trim(),
        excerpt: excerpt.trim(),
        body,
        readTimeMinutes,
        category,
        coverImageUrl: coverImage,
        isPublished: published,
        publishedAt: published ? now : null,
      },
    });
    res.status(201).json({ success: true, message: 'Blog post created.', data: post });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError('A blog post with this slug already exists. Choose a different slug.', 409);
    }
    throw e;
  }
});

export const updateBlogPost = catchAsync(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { title, excerpt, body, slug: slugRaw, readTimeMinutes: rtm, isPublished, coverImageUrl } =
    req.body;

  const existing = await prisma.blogPost.findUnique({ where: { id } });
  if (!existing) throw new AppError('Blog post not found.', 404);

  const now = new Date();

  const filePath = (req.file as Express.Multer.File & { path?: string })?.path;
  const coverFromFile = filePath ?? undefined;
  const coverFromBody =
    coverImageUrl !== undefined
      ? typeof coverImageUrl === 'string' && coverImageUrl.trim()
        ? coverImageUrl.trim()
        : null
      : undefined;
  const nextCover = coverFromFile !== undefined ? coverFromFile : coverFromBody;

  const data: Prisma.BlogPostUpdateInput = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new AppError('title cannot be empty.', 400);
    data.title = title.trim();
  }
  if (excerpt !== undefined) {
    if (typeof excerpt !== 'string' || !excerpt.trim()) throw new AppError('excerpt cannot be empty.', 400);
    data.excerpt = excerpt.trim();
  }
  if (body !== undefined) {
    if (typeof body !== 'string') throw new AppError('body is required when provided.', 400);
    data.body = body;
  }
  if (slugRaw !== undefined) {
    const ns = normalizeSlug(String(slugRaw));
    if (!ns) throw new AppError('slug is invalid.', 400);
    data.slug = ns;
  }
  if (req.body.category !== undefined) {
    data.category = parseBlogCategory(req.body.category, true)!;
  }
  if (rtm !== undefined && rtm !== null && rtm !== '') {
    const n = parseInt(String(rtm), 10);
    if (Number.isNaN(n) || n < 1) {
      throw new AppError('readTimeMinutes must be a positive integer.', 400);
    }
    data.readTimeMinutes = n;
  }
  if (isPublished !== undefined) {
    const nextPub = parseBoolean(isPublished);
    data.isPublished = nextPub;
    if (nextPub && !existing.publishedAt) {
      data.publishedAt = now;
    } else if (!nextPub) {
      data.publishedAt = null;
    }
  }
  if (nextCover !== undefined) {
    data.coverImageUrl = nextCover;
  }

  if (Object.keys(data).length === 0) {
    throw new AppError('No fields to update. Send at least one of title, excerpt, body, slug, category, readTimeMinutes, isPublished, coverImage, coverImageUrl.', 400);
  }

  try {
    const post = await prisma.blogPost.update({
      where: { id },
      data,
    });
    res.json({ success: true, message: 'Blog post updated.', data: post });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError('A blog post with this slug already exists. Choose a different slug.', 409);
    }
    throw e;
  }
});

export const deleteBlogPost = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await prisma.blogPost.delete({ where: { id } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new AppError('Blog post not found.', 404);
    }
    const fk = mapForeignKeyDeleteError(e);
    if (fk) throw fk;
    throw e;
  }

  res.json({ success: true, message: 'Blog post deleted.' });
});
