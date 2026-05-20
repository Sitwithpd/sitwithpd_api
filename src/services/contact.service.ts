import prisma from '../config/prisma';

export const CONTACT_FULL_NAME_MAX = 120;
export const CONTACT_PHONE_MAX = 30;
export const CONTACT_MESSAGE_MIN = 10;
export const CONTACT_MESSAGE_MAX = 5000;
export const CONTACT_ADMIN_SEARCH_MAX_LEN = 100;

export interface SubmitContactInput {
  fullName: string;
  email: string;
  phone?: string | null;
  message: string;
  source?: string;
}

export async function createContactSubmission(input: SubmitContactInput) {
  const source =
    typeof input.source === 'string' && input.source.trim()
      ? input.source.trim().slice(0, 120)
      : 'contact_page';

  return prisma.contactSubmission.create({
    data: {
      fullName: input.fullName.trim().slice(0, CONTACT_FULL_NAME_MAX),
      email: input.email.trim().toLowerCase(),
      phone: input.phone?.trim() ? input.phone.trim().slice(0, CONTACT_PHONE_MAX) : null,
      message: input.message.trim().slice(0, CONTACT_MESSAGE_MAX),
      source,
    },
  });
}

export async function listContactSubmissionsAdmin(opts: {
  skip: number;
  take: number;
  search: string;
}) {
  const { skip, take, search } = opts;
  const where =
    search.length > 0
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { fullName: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

  const [rows, total] = await Promise.all([
    prisma.contactSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.contactSubmission.count({ where }),
  ]);

  return { rows, total };
}
