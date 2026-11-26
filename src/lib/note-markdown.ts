import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkMath);
type MarkdownRoot = ReturnType<typeof markdownParser.parse>;
export type MarkdownNode = MarkdownRoot | MarkdownRoot['children'][number];

export type NoteHeading = {
  title: string;
  depth: number;
  offset: number;
  children: NoteHeading[];
};

export type NoteLink = { label: string; target: string };

export function* walkMarkdown(node: MarkdownNode): Generator<MarkdownNode> {
  yield node;
  if ('children' in node) {
    for (const child of node.children) yield* walkMarkdown(child);
  }
}

export function inlineText(node: MarkdownNode): string {
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

export function readLinkDefinitions(nodes: Iterable<MarkdownNode>) {
  const definitions = new Map<string, Extract<MarkdownNode, { type: 'definition' }>>();
  for (const node of nodes) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
  }
  return definitions;
}

export function readNoteMarkdown(content: string) {
  const document = parseNoteMarkdown(content);
  const frontmatter = document.children[0]?.type === 'yaml' ? document.children[0].value : null;
  const nodes = [...walkMarkdown(document)];
  const definitions = readLinkDefinitions(nodes);

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
      const target = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
      if (target) links.push({ label: inlineText(node) || target, target });
    }
  }

  return { frontmatter, headings, links };
}

