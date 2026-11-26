export type SearchOptions = {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export type SearchRun = { from: number; text: string };
export type SearchMatch = { from: number; to: number };
export type SearchResult = { matches: SearchMatch[]; error?: string };

const wordCharacter = /[\p{L}\p{M}\p{N}\p{Pc}]/u;
const maxMatches = 10_000;

function characterBefore(text: string, offset: number) {
  const previous = text.charCodeAt(offset - 1);
  return text.slice(offset - (previous >= 0xdc00 && previous <= 0xdfff ? 2 : 1), offset);
}

export function findMatches(runs: SearchRun[], options: SearchOptions): SearchResult {
  if (!options.query) return { matches: [] };
  const pattern = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, options.caseSensitive ? 'gu' : 'giu');
  } catch {
    return { matches: [], error: 'Invalid regular expression.' };
  }

  const matches: SearchMatch[] = [];
  for (const { from, text } of runs) {
    expression.lastIndex = 0;
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      const start = match.index;
      if (!match[0].length) {
        // Advance by a full Unicode code point so the next exec cannot revisit this offset.
        expression.lastIndex = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
        continue;
      }
      const end = start + match[0].length;
      const next = text.codePointAt(end);
      if (options.wholeWord && (
        (start > 0 && wordCharacter.test(characterBefore(text, start)))
        || (next !== undefined && wordCharacter.test(String.fromCodePoint(next)))
      )) continue;
      if (matches.length === maxMatches) {
        return { matches: [], error: 'More than 10,000 matches. Narrow your search.' };
      }
      matches.push({ from: from + start, to: from + end });
    }
  }
  return { matches };
}
