import type { ChangeSet } from '@codemirror/state';

export const firstLineEnding = (content: string) => content.match(/\r\n|\r|\n/)?.[0] ?? '\n';

export const normalizeNewlines = (content: string) => content.replace(/\r\n?/g, '\n');

function advanceOriginalOffset(content: string, index: number, distance: number) {
  for (let offset = 0; index < content.length && offset < distance; index++, offset++) {
    if (content[index] === '\r' && content[index + 1] === '\n') index++;
  }
  return index;
}

export function originalSourceOffset(content: string, normalizedOffset: number) {
  return content.includes('\r') ? advanceOriginalOffset(content, 0, normalizedOffset) : Math.min(content.length, normalizedOffset);
}

export function restoreSourceChanges(previous: string, changes: ChangeSet) {
  const newline = firstLineEnding(previous);
  const hasCarriageReturn = previous.includes('\r');
  let previousOffset = 0;
  let rawOffset = 0;
  const parts: string[] = [];

  changes.iterChanges((from, to, _nextFrom, _nextTo, insert) => {
    const rawFrom = hasCarriageReturn ? advanceOriginalOffset(previous, rawOffset, from - previousOffset) : from;
    parts.push(previous.slice(rawOffset, rawFrom), insert.sliceString(0, insert.length, newline));
    rawOffset = hasCarriageReturn ? advanceOriginalOffset(previous, rawFrom, to - from) : to;
    previousOffset = to;
  });
  parts.push(previous.slice(rawOffset));

  return parts.join('');
}
