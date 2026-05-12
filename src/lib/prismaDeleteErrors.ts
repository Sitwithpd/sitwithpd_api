import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/error.middleware';

/** HTTP status when a delete is blocked by foreign-key dependents (matches REST “conflict”). */
const FK_CONFLICT = 409;

/**
 * Maps Prisma / Postgres foreign-key violations on delete into operational AppErrors.
 * Raw engine errors often expose `violates RESTRICT` or Prisma `P2003`.
 */
export function mapForeignKeyDeleteError(err: unknown): AppError | null {
  const msg = err instanceof Error ? err.message : String(err);

  const isFkViolation =
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') ||
    msg.includes('violates RESTRICT') ||
    msg.includes('Foreign key constraint') ||
    msg.includes('foreign key constraint');

  if (!isFkViolation) return null;

  if (
    msg.includes('purchases_programId_fkey') ||
    msg.includes('referenced from table') && msg.includes('purchases') && msg.includes('programs')
  ) {
    return new AppError(
      'This program cannot be deleted because it has existing enrollments.',
      FK_CONFLICT
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    const meta = err.meta as {
      field_name?: string;
      model_name?: string;
      constraint?: unknown;
    };
    const constraint = String(meta?.constraint ?? '');
    if (constraint.includes('purchases_programId')) {
      return new AppError(
        'This program cannot be deleted because it has existing enrollments.',
        FK_CONFLICT
      );
    }
  }

  return new AppError(
    'This record cannot be deleted because other data still depends on it.',
    FK_CONFLICT
  );
}
