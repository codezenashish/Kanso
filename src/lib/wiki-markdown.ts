import { inlineText, parseNoteMarkdown, walkMarkdown } from './note-markdown';
import { noteExtensionPattern } from './workspace-tree';

export type WikiReference = {
  start: number;
  end: number;
  target: string;
  alias: string | null;
  context: string;
};

const wikiPattern = /\[\[([^\[\]|\\\r\n]+?)(?:\\?\|([^\[\]|\r\n]*))?\]\]/g;
const literalNodes = new Set(['yaml', 'toml', 'code', 'inlineCode', 'math', 'inlineMath', 'definition', 'html', 'link', 'linkReference', 'image', 'imageReference']);

function literalRanges(source: string) {
  return [...walkMarkdown(parseNoteMarkdown(source))]
    .filter((node) => literalNodes.has(node.type))
    .map(({ position }) => [position!.start.offset!, position!.end.offset!] as const);
}

export function wikiInputContext(source: string, offset: number) {
  let inTable = false;
  for (const node of walkMarkdown(parseNoteMarkdown(source))) {
    const { start, end } = node.position!;
    if (start.offset! > offset || end.offset! <= offset) continue;
    if (literalNodes.has(node.type)) return null;
    if (node.type === 'table') inTable = true;
  }
  return { inTable };
}

export function wikiLabel(target: string) {
  const path = target.replace(/#\^[A-Za-z0-9_-]+$/, '');
  return path.slice(path.lastIndexOf('/') + 1).replace(noteExtensionPattern, '') || path;
}

export function scanWikiLinks(source: string): WikiReference[] {
  if (!source.includes('[[')) return [];
  const ranges = literalRanges(source);
  return Array.from(source.matchAll(wikiPattern)).flatMap((match) => {
    const start = match.index!;
    const end = start + match[0].length;
    let escape = start;
    while (escape > 0 && source[escape - 1] === '\\') escape--;
    if ((start - escape) % 2 || ranges.some(([from, to]) => (from <= start && to > start) || (from < end && to >= end))) return [];
    const target = match[1].trim();
    if (!target) return [];
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = source.indexOf('\n', end);
    return [{
      start, end, target, alias: match[2]?.trim() || null,
      context: source.slice(Math.max(lineStart, start - 65), Math.min(lineEnd < 0 ? source.length : lineEnd, end + 65)).trim(),
    }];
  });
}

export function findWikiReferenceOnLine(lineText: string, offsetInLine: number): WikiReference | null {
  if (!lineText.includes('[[')) return null;
  for (const match of lineText.matchAll(wikiPattern)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (offsetInLine < start || offsetInLine > end) continue;
    let escape = start;
    while (escape > 0 && lineText[escape - 1] === '\\') escape--;
    if ((start - escape) % 2) continue;
    const target = match[1].trim();
    if (!target) continue;
    return {
      start,
      end,
      target,
      alias: match[2]?.trim() || null,
      context: lineText.trim(),
    };
  }
  return null;
}

export function wikiSyntax(target: string, alias: string | null = null, inTable = false) {
  return `[[${target}${alias ? `${inTable ? '\\|' : '|'}${alias}` : ''}]]`;
}

export function plainWikiText(text: string) {
  return text.replace(wikiPattern, (_, target: string, alias?: string) => alias?.trim() || wikiLabel(target.trim()));
}

function excerpt(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 190 ? clean.slice(0, 189).trimEnd() + '…' : clean;
}

export function notePreviewText(source: string, markdown: boolean) {
  const bounded = source.slice(0, 8192);
  if (!markdown) return excerpt(bounded);
  const document = parseNoteMarkdown(bounded);
  for (const node of walkMarkdown(document)) {
    if (node.type === 'paragraph' || node.type === 'tableCell' || node.type === 'code') {
      const preview = excerpt(plainWikiText(inlineText(node)));
      if (preview) return preview;
    }
  }
  const heading = document.children.find((node) => node.type === 'heading');
  return heading ? excerpt(plainWikiText(inlineText(heading))) : '';
}

export function prepareWikiMarkdown(source: string) {
  const references = scanWikiLinks(source);
  // Mask links without changing source offsets. A separate start marker
  // keeps adjacent links distinct when the Markdown parser joins text nodes.
  let markerCode = 0xE000;
  while (source.includes(String.fromCodePoint(markerCode))) markerCode++;
  const marker = String.fromCodePoint(markerCode);
  let fill = markerCode + 1;
  while (source.includes(String.fromCodePoint(fill))) fill++;
  const filler = String.fromCodePoint(fill);
  const starts = new Map<number, WikiReference>();
  let masked = '';
  let from = 0;
  for (const link of references) {
    masked += source.slice(from, link.start) + marker + filler.repeat(link.end - link.start - 1);
    starts.set(link.start, link);
    from = link.end;
  }
  masked += source.slice(from);
  return { masked, marker, starts };
}
