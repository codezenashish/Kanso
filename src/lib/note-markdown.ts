import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml']);
type MarkdownRoot = ReturnType<typeof markdownParser.parse>;
export type MarkdownNode = MarkdownRoot | MarkdownRoot['children'][number];

export type NoteHeading = {
  title: string;
  depth: number;
  offset: number;
  children: NoteHeading[];
};

type NoteLink = { label: string; target: string };

export function* walkMarkdown(node: MarkdownNode): Generator<MarkdownNode> {
  yield node;
  if ('children' in node) {
    for (const child of node.children) yield* walkMarkdown(child);
  }
}

function inlineText(node: MarkdownNode): string {
  if ('value' in node) return node.value;
  if ('alt' in node) return node.alt ?? '';
  if ('children' in node) return node.children.map((child) => inlineText(child)).join('');
  return '';
}

export function parseNoteMarkdown(content: string) {
  const document = markdownParser.parse(content);
  // The Markdown parser ignores the BOM when calculating source positions.
  if (content.startsWith('\uFEFF')) {
    for (const node of walkMarkdown(document)) {
      const position = node.position;
      if (position?.start.offset !== undefined) position.start.offset++;
      if (position?.end.offset !== undefined) position.end.offset++;
    }
  }
  return document;
}

export function readNoteMarkdown(content: string) {
  const nodes = [...walkMarkdown(parseNoteMarkdown(content))];
  const definitions = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  }

  const headings: NoteHeading[] = [];
  const parents: NoteHeading[] = [];
  const links: NoteLink[] = [];

  for (const node of nodes) {
    if (node.type === 'heading' && node.position?.start.offset !== undefined) {
      const heading = { title: inlineText(node), depth: node.depth, offset: node.position.start.offset, children: [] };
      while (parents.length && parents[parents.length - 1].depth >= heading.depth) parents.pop();
      (parents[parents.length - 1]?.children ?? headings).push(heading);
      parents.push(heading);
    }
    if (node.type === 'link' || node.type === 'linkReference') {
      const target = node.type === 'link' ? node.url : definitions.get(node.identifier);
      if (target) links.push({ label: inlineText(node) || target, target });
    }
  }

  return { headings, links: [...new Map(links.map((link) => [link.target, link])).values()] };
}

