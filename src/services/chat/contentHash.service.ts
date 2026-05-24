import crypto from 'crypto';

/** Normalize text before hashing so whitespace-only edits do not re-embed. */
export function normalizeContentForHash(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(normalizeContentForHash(text), 'utf8').digest('hex');
}
