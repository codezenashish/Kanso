export const firstLineEnding = (content: string) => content.match(/\r\n|\r|\n/)?.[0] ?? '\n';

export const normalizeNewlines = (content: string) => content.replace(/\r\n?/g, '\n');

export function originalSourceOffset(content: string, normalizedOffset: number) {
  let index = 0;
  for (let offset = 0; index < content.length && offset < normalizedOffset; index++, offset++) {
    if (content[index] === '\r' && content[index + 1] === '\n') index++;
  }
  return index;
}

export function restoreSourceNewlines(previous: string, next: string) {
  if (!previous.includes('\r')) return next;
  const normalized = normalizeNewlines(previous);
  let start = 0;
  while (start < next.length && next[start] === normalized[start]) start++;
  let afterPrevious = normalized.length;
  let afterNext = next.length;
  while (afterPrevious > start && afterNext > start && normalized[afterPrevious - 1] === next[afterNext - 1]) {
    afterPrevious--;
    afterNext--;
  }
  return previous.slice(0, originalSourceOffset(previous, start))
    + next.slice(start, afterNext).replace(/\n/g, firstLineEnding(previous))
    + previous.slice(originalSourceOffset(previous, afterPrevious));
}
