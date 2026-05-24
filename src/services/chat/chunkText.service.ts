/** Approximate max characters per chunk (~500–800 tokens). */
const DEFAULT_MAX_CHARS = 3200;

const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Split long plain text into overlapping chunks on paragraph boundaries.
 * Short text returns a single segment.
 */
export function chunkPlainText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  overlapChars: number = DEFAULT_OVERLAP_CHARS
): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [normalized.slice(0, maxChars)];

  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      pushCurrent();
      chunks.push(...splitOversizedParagraph(paragraph, maxChars, overlapChars));
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      pushCurrent();
      current = paragraph;
    }
  }

  pushCurrent();
  return mergeWithOverlap(chunks, overlapChars);
}

function splitOversizedParagraph(text: string, maxChars: number, overlapChars: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return parts.filter(Boolean);
}

function mergeWithOverlap(chunks: string[], overlapChars: number): string[] {
  if (chunks.length <= 1 || overlapChars <= 0) return chunks;

  const merged: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = merged[merged.length - 1];
    const tail = prev.slice(Math.max(0, prev.length - overlapChars));
    merged.push(`${tail}\n\n${chunks[i]}`.trim());
  }
  return merged;
}
