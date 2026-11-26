import type { Mark, Node as EditorNode, Schema } from '@tiptap/pm/model';
import { parseNoteMarkdown, readLinkDefinitions, walkMarkdown, type MarkdownNode } from '@/lib/note-markdown';
import { prepareWikiMarkdown, wikiSyntax } from '@/lib/wiki-markdown';
import { attachmentDestination, readAttachmentAttrs, type AttachmentAttrs } from './attachments/attachment-markdown';
import { defaultTiptapMarkdownMarks, defaultTiptapMarkdownNodes, MarkdownSerializer } from './markdown-serializer';
import { firstLineEnding, normalizeNewlines } from './source-newlines';
import { safeHref, visualSchema } from './extensions/visual-extensions';

export { visualSchema };

const emptyTaskMarker = '\u200b';

export function parseSafeLinkInput(raw: string) {
  const href = raw.trim().replace(/ /g, '%20');
  return { href, invalid: Boolean(href && !safeHref(href)) };
}

export function markdownDestination(target: string) {
  const escaped = target.replace(/[\r\n]/g, (newline) => encodeURIComponent(newline));
  return /[\s<>]/.test(escaped)
    ? `<${escaped.replace(/[\\<>]/g, '\\$&')}>`
    : escaped.replace(/[\\()"]/g, '\\$&');
}

function markdownTitle(title: string | null) {
  return title ? ` "${title.replace(/[\\"]/g, '\\$&')}"` : '';
}

export function serializeAttachmentMarkdown(attrs: AttachmentAttrs) {
  const label = attrs.label.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]<>~|$^=&#]/g, '\\$&');
  const title = markdownTitle(attrs.title?.replace(/&/g, '&amp;') ?? null);
  return `${attrs.kind === 'image' ? '!' : ''}[${label}](${attachmentDestination(attrs)}${title})`;
}

const markdownNodes: MarkdownSerializer['nodes'] = {
  ...defaultTiptapMarkdownNodes,
  wiki_link(state, node) {
    state.write(wikiSyntax(node.attrs.target, node.attrs.alias));
  },
  footnote_reference(state, node) {
    state.write(`[^${node.attrs.id}]`);
  },
  inline_math(state, node) {
    const latex = String(node.attrs.latex ?? '').replace(/\r?\n/g, ' ');
    if (latex) state.write(`$${latex}$`);
  },
  managed_attachment(state, node) {
    state.write(serializeAttachmentMarkdown(node.attrs as AttachmentAttrs));
  },
  image(state, node) {
    const { src, alt, title } = node.attrs;
    state.write(`![${state.esc(alt ?? '')}](${markdownDestination(src)}${markdownTitle(title)})`);
  },
};

const markdownMarks: MarkdownSerializer['marks'] = {
  ...defaultTiptapMarkdownMarks,
  link: {
    open: '[',
    close: (_state, mark) => `](${markdownDestination(mark.attrs.href)}${markdownTitle(mark.attrs.title)})`,
    mixable: true,
  },
  underline: { open: '<u>', close: '</u>', mixable: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  highlight: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
  superscript: { open: '^', close: '^', mixable: true },
  subscript: { open: '~', close: '~', mixable: true },
};

const tableCellSerializer = new MarkdownSerializer({
  ...markdownNodes,
  hardBreak(state) { state.write('<br>'); },
}, markdownMarks, { escapeExtraCharacters: /[<>&]/g, hardBreakNodeName: 'hardBreak' });

const serializer = new MarkdownSerializer({
  ...markdownNodes,
  listItem(state, node) {
    if (node.attrs.checked !== null) {
      state.write(node.attrs.checked ? '[x] ' : '[ ] ');
      if (node.firstChild?.isTextblock && !node.firstChild.content.size) state.write('&#8203;');
    }
    state.renderContent(node);
  },
  callout(state, node) {
    const kind = String(node.attrs.kind || 'note').toUpperCase();
    const title = node.attrs.title ? ` ${String(node.attrs.title).trim()}` : '';
    state.wrapBlock('> ', null, node, () => {
      state.write(`[!${kind}]${title}\n`);
      state.renderContent(node);
    });
  },
  footnote_definition(state, node) {
    const prefix = `[^${node.attrs.id}]: `;
    state.wrapBlock('    ', prefix, node, () => {
      state.renderContent(node);
    });
  },
  mermaid_block(state, node) {
    const code = String(node.attrs.code ?? '');
    state.write('```mermaid\n');
    if (code) state.text(code, false);
    if (code && !code.endsWith('\n')) state.write('\n');
    state.write('```');
    state.closeBlock(node);
  },
  table(state, node) {
    node.forEach((row, _offset, rowIndex) => {
      const values: string[] = [];
      const separators: string[] = [];
      row.forEach((cell) => {
        const inline = tableCellSerializer.serialize(node.type.schema.nodes.doc.create(null, cell.firstChild));
        values.push(inline.replace(/\|/g, '\\|').replace(/\n/g, '<br>'));
        const { align } = cell.attrs;
        separators.push(align === 'left' ? ':---' : align === 'right' ? '---:' : align === 'center' ? ':---:' : '---');
      });
      state.write(`| ${values.join(' | ')} |${rowIndex === 0 || rowIndex < node.childCount - 1 ? '\n' : ''}`);
      if (rowIndex === 0) state.write(`| ${separators.join(' | ')} |${node.childCount > 1 ? '\n' : ''}`);
    });
    state.closeBlock(node);
  },
  math_block(state, node) {
    const latex = String(node.attrs.latex ?? '');
    state.write('$$\n');
    if (latex) state.text(latex, false);
    state.write('\n$$');
    state.closeBlock(node);
  },
  yaml_frontmatter(state, node) {
    state.text(node.attrs.source, false);
    state.closeBlock(node);
  },
  preserved_markdown(state, node) {
    state.text(node.textContent, false);
    state.closeBlock(node);
  },
}, markdownMarks, { escapeExtraCharacters: /[<>&|]/g, hardBreakNodeName: 'hardBreak' });

export const serializeVisualDocument = (document: EditorNode) => serializer.serialize(document);

type MarkdownContext = ReturnType<typeof prepareWikiMarkdown> & { definitions: ReturnType<typeof readLinkDefinitions> };

const inlineDelimiterRules = [
  { mark: 'highlight', pattern: /==([^\n=](?:[^\n]*?[^\n=])?)==/ },
  { mark: 'superscript', pattern: /\^([^[\]\s^\n](?:[^\n^]*?[^\n^\s])?)\^/ },
  { mark: 'subscript', pattern: /~([^~\s\n](?:[^\n~]*?[^\n~\s])?)~/ },
] as const;

function pushFormattedText(text: string, marks: readonly Mark[], target: EditorNode[], schema: Schema) {
  if (!text) return;
  let earliestIndex = -1;
  let earliestMatch: RegExpExecArray | null = null;
  let earliestMark: 'highlight' | 'superscript' | 'subscript' | null = null;

  for (const rule of inlineDelimiterRules) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (earliestIndex === -1 || match.index < earliestIndex) {
      earliestIndex = match.index;
      earliestMatch = match;
      earliestMark = rule.mark;
    }
  }

  if (!earliestMatch || !earliestMark) {
    target.push(schema.text(text, marks));
    return;
  }

  if (earliestIndex > 0) {
    target.push(schema.text(text.slice(0, earliestIndex), marks));
  }
  const mark = schema.marks[earliestMark].create();
  pushFormattedText(earliestMatch[1], mark.addToSet(marks), target, schema);
  pushFormattedText(text.slice(earliestIndex + earliestMatch[0].length), marks, target, schema);
}

const inlineHtmlMarks: Record<string, 'underline' | 'highlight' | 'superscript' | 'subscript'> = {
  '<u>': 'underline',
  '<mark>': 'highlight',
  '<sup>': 'superscript',
  '<sub>': 'subscript',
};

function convertInline(
  children: MarkdownNode[],
  context: MarkdownContext,
  schema: Schema,
  marks: readonly Mark[] = [],
  inTable = false,
): EditorNode[] {
  const editorInline: EditorNode[] = [];
  const { marks: types, nodes } = schema;

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    switch (child.type) {
      case 'text': {
        let remaining = child.value;
        let offset = child.position?.start.offset ?? 0;
        while (context.starts.size && remaining.includes(context.marker)) {
          const marker = remaining.indexOf(context.marker);
          const start = context.masked.indexOf(context.marker, offset);
          const link = context.starts.get(start);
          if (!link) break;
          if (marker) pushFormattedText(remaining.slice(0, marker), marks, editorInline, schema);
          editorInline.push(nodes.wiki_link.create({ target: link.target, alias: link.alias }, null, marks));
          remaining = remaining.slice(marker + link.end - link.start);
          offset = link.end;
        }
        if (remaining) pushFormattedText(remaining, marks, editorInline, schema);
        break;
      }
      case 'inlineCode':
        if (child.value) editorInline.push(schema.text(child.value, types.code.create().addToSet(marks)));
        break;
      case 'inlineMath': {
        const latex = normalizeNewlines(child.value).replace(/\n/g, ' ');
        editorInline.push(nodes.inline_math.create({ latex }, null, marks));
        break;
      }
      case 'footnoteReference':
        editorInline.push(nodes.footnote_reference.create({ id: child.identifier }, null, marks));
        break;
      case 'emphasis':
      case 'strong':
      case 'delete': {
        const mark = types[child.type === 'emphasis' ? 'italic' : child.type === 'delete' ? 'strike' : 'bold'].create();
        editorInline.push(...convertInline(child.children, context, schema, mark.addToSet(marks), inTable));
        break;
      }
      case 'link':
      case 'linkReference': {
        const target = child.type === 'link' ? child : context.definitions.get(child.identifier);
        if (!target) throw new Error('Missing Markdown link definition');
        const attachment = child.children.every((part) => part.type === 'text')
          ? readAttachmentAttrs(target.url, 'file', child.children.map((part) => part.type === 'text' ? part.value : '').join(''), target.title)
          : null;
        if (attachment) {
          editorInline.push(nodes.managed_attachment.create(attachment, null, marks));
          break;
        }
        const link = types.link.create({ href: target.url, title: target.title });
        editorInline.push(...convertInline(child.children, context, schema, link.addToSet(marks), inTable));
        break;
      }
      case 'image':
      case 'imageReference': {
        const target = child.type === 'image' ? child : context.definitions.get(child.identifier);
        if (!target) throw new Error('Missing Markdown image definition');
        const attachment = readAttachmentAttrs(target.url, 'image', child.alt ?? '', target.title);
        editorInline.push(attachment ? nodes.managed_attachment.create(attachment, null, marks)
          : nodes.image.create({ src: target.url, alt: child.alt, title: target.title }, null, marks));
        break;
      }
      case 'break':
        editorInline.push(nodes.hardBreak.create());
        break;
      case 'html': {
        if (inTable && /^<br\s*\/?>$/i.test(child.value)) {
          editorInline.push(nodes.hardBreak.create());
          break;
        }
        const openTag = child.value.toLowerCase();
        const markName = inlineHtmlMarks[openTag];
        const closeTag = markName ? `</${openTag.slice(1)}` : '';
        const closingIndex = markName
          ? children.findIndex((sibling, siblingIndex) => (
            siblingIndex > index && sibling.type === 'html' && sibling.value.toLowerCase() === closeTag
          ))
          : -1;
        if (!markName || closingIndex === -1) throw new Error('Unsupported inline HTML');
        editorInline.push(...convertInline(children.slice(index + 1, closingIndex), context, schema, types[markName].create().addToSet(marks), inTable));
        index = closingIndex;
        break;
      }
      default:
        throw new Error('Unsupported inline Markdown');
    }
  }
  return editorInline;
}

function standaloneBlockMath(node: Extract<MarkdownNode, { type: 'paragraph' }>, context: MarkdownContext): string | null {
  const meaningful = node.children.filter((child) => !(child.type === 'text' && !child.value.trim()));
  if (meaningful.length !== 1) return null;
  const onlyChild = meaningful[0];
  if (onlyChild.type !== 'inlineMath') return null;
  const start = onlyChild.position?.start.offset;
  const end = onlyChild.position?.end.offset;
  if (start === undefined || end === undefined || end - start < 4) return null;
  const raw = context.masked.slice(start, end);
  return raw.startsWith('$$') && raw.endsWith('$$') ? onlyChild.value : null;
}

const calloutHeaderPattern = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/i;

function convertCallout(
  node: Extract<MarkdownNode, { type: 'blockquote' }>,
  context: MarkdownContext,
  attrs: { sourceIndex: number | null },
  schema: Schema,
): EditorNode | null {
  const first = node.children[0];
  if (!first || first.type !== 'paragraph') return null;
  const lead = first.children[0];
  if (!lead || lead.type !== 'text') return null;
  const normalizedLead = normalizeNewlines(lead.value);
  const match = calloutHeaderPattern.exec(normalizedLead);
  if (!match) return null;
  const hasLineBreakAfterHeader = normalizedLead.includes('\n')
    || first.children.length === 1
    || first.children[1]?.type === 'break';
  if (!hasLineBreakAfterHeader) return null;

  const kind = match[1].toLowerCase();
  const title = match[2]?.trim() || null;
  const remainderText = match[3] ?? '';
  const tailChildren = first.children.slice(first.children[1]?.type === 'break' && !normalizedLead.includes('\n') ? 2 : 1);
  const firstInlineNodes: MarkdownNode[] = [];
  if (remainderText) firstInlineNodes.push({ ...lead, value: remainderText });
  firstInlineNodes.push(...tailChildren);

  const { nodes } = schema;
  const bodyBlocks: EditorNode[] = [];
  if (firstInlineNodes.length) {
    bodyBlocks.push(nodes.paragraph.createChecked(null, convertInline(firstInlineNodes, context, schema)));
  }
  for (let index = 1; index < node.children.length; index++) {
    bodyBlocks.push(convertBlock(node.children[index], context, null, schema));
  }
  if (!bodyBlocks.length) bodyBlocks.push(nodes.paragraph.create());
  return nodes.callout.createChecked({ ...attrs, kind, title }, bodyBlocks);
}

function convertBlock(
  node: MarkdownNode,
  context: MarkdownContext,
  sourceIndex: number | null = null,
  schema: Schema = visualSchema,
): EditorNode {
  const { nodes } = schema;
  const attrs = { sourceIndex };
  switch (node.type) {
    case 'heading':
      return nodes.heading.createChecked({ ...attrs, level: node.depth }, convertInline(node.children, context, schema));
    case 'paragraph': {
      const blockLatex = standaloneBlockMath(node, context);
      if (blockLatex !== null) {
        return nodes.math_block.create({ ...attrs, latex: normalizeNewlines(blockLatex) });
      }
      return nodes.paragraph.createChecked(attrs, convertInline(node.children, context, schema));
    }
    case 'math':
      return nodes.math_block.create({ ...attrs, latex: normalizeNewlines(node.value) });
    case 'blockquote': {
      const calloutNode = convertCallout(node, context, attrs, schema);
      if (calloutNode) return calloutNode;
      return nodes.blockquote.createChecked(attrs, node.children.length ? node.children.map((child) => convertBlock(child, context, null, schema)) : [nodes.paragraph.create()]);
    }
    case 'footnoteDefinition': {
      const children = node.children.map((child) => convertBlock(child, context, null, schema));
      return nodes.footnote_definition.createChecked(
        { ...attrs, id: node.identifier },
        children.length ? children : [nodes.paragraph.create()],
      );
    }
    case 'code': {
      const params = [node.lang, node.meta].filter(Boolean).join(' ');
      if (params.includes('`')) throw new Error('Unsupported code fence info');
      if (node.lang?.toLowerCase() === 'mermaid' && !node.meta) {
        return nodes.mermaid_block.create({ ...attrs, code: normalizeNewlines(node.value) });
      }
      return nodes.codeBlock.create({ ...attrs, params }, node.value ? schema.text(node.value) : undefined);
    }
    case 'thematicBreak':
      return nodes.horizontalRule.create(attrs);
    case 'list':
      return nodes[node.ordered ? 'orderedList' : 'bulletList'].createChecked(
        { ...attrs, start: node.start ?? 1, tight: !node.spread && node.children.every((item) => !item.spread) },
        node.children.map((item) => convertBlock(item, context, null, schema)),
      );
    case 'listItem': {
      const children = node.children.map((child) => convertBlock(child, context, null, schema));
      if (node.checked != null && children[0]?.textContent === emptyTaskMarker) children[0] = nodes.paragraph.create();
      return nodes.listItem.createChecked({ checked: node.checked ?? null }, children.length
        ? children : [nodes.paragraph.create()]);
    }
    case 'table': {
      const columnCount = node.children[0]?.children.length ?? 0;
      if (!columnCount || node.children.some((row) => row.children.length > columnCount)) throw new Error('Unsupported table shape');
      return nodes.table.createChecked(attrs, node.children.map((row, rowIndex) => nodes.tableRow.create(
        null,
        Array.from({ length: columnCount }, (_, column) => (rowIndex === 0 ? nodes.tableHeader : nodes.tableCell).create(
          { align: node.align?.[column] ?? null },
          nodes.paragraph.create(null, convertInline(row.children[column]?.children ?? [], context, schema, [], true)),
        )),
      )));
    }
    default:
      throw new Error('Unsupported Markdown block');
  }
}

type OriginalBlock = { node: EditorNode; start: number; end: number };
export type VisualMarkdown = { source: string; document: EditorNode; originals: OriginalBlock[] };
type BlockRange = { node: EditorNode; editorFrom: number; sourceFrom: number; sourceText: string };

export function readVisualMarkdown(source: string, schema: Schema = visualSchema): VisualMarkdown {
  const prepared = prepareWikiMarkdown(source);
  const parsed = parseNoteMarkdown(prepared.masked);
  const context = { ...prepared, definitions: readLinkDefinitions(walkMarkdown(parsed)) };
  const originals = parsed.children.map((block, sourceIndex) => {
    const { start, end } = block.position!;
    const from = start.offset! - (start.column - 1);
    const to = end.offset!;
    const markdown = source.slice(from, to);
    let node: EditorNode;
    try {
      for (const part of walkMarkdown(block)) {
        if (part.type === 'text' && /\[\[|%%|(?:^|\n):::|(?:^|\s)\^[\w-]+$/.test(part.value)) {
          throw new Error('Unsupported Markdown extension');
        }
      }
      node = block.type === 'yaml'
        ? schema.nodes.yaml_frontmatter.create({ sourceIndex, source: normalizeNewlines(markdown) })
        : convertBlock(block, context, sourceIndex, schema);
    } catch {
      const rawText = normalizeNewlines(markdown);
      node = schema.nodes.preserved_markdown.create({ sourceIndex }, rawText ? schema.text(rawText) : undefined);
    }
    return { node, start: from, end: to };
  });
  const document = schema.nodes.doc.createAndFill(null, originals.map((block) => block.node))!;
  return { source, document, originals };
}

const serializedBlocks = new WeakMap<EditorNode, string>();

function serializeBlock(node: EditorNode) {
  const cached = serializedBlocks.get(node);
  if (cached !== undefined) return cached;
  const text = serializeVisualDocument(node.type.schema.nodes.doc.create(null, node));
  serializedBlocks.set(node, text);
  return text;
}

export function writeVisualMarkdown(markdown: VisualMarkdown, document: EditorNode) {
  const { originals, source } = markdown;
  const first = originals[0];
  const last = originals[originals.length - 1];
  const blocks: BlockRange[] = [];
  const usedOriginals = new Set<number>();
  const newline = firstLineEnding(source);
  let content = first ? source.slice(0, first.start) : '';
  let previousIndex: number | null = null;

  document.forEach((node, editorFrom, index) => {
    if (index === 1 && document.childCount === 2 && document.firstChild?.type.name === 'yaml_frontmatter'
      && node.type.name === 'paragraph' && !node.content.size) return;
    const originalIndex: number | null = node.attrs.sourceIndex ?? null;
    const sourceIndex = originalIndex !== null && !usedOriginals.has(originalIndex) ? originalIndex : null;
    const original = sourceIndex === null ? undefined : originals[sourceIndex];
    if (sourceIndex !== null) usedOriginals.add(sourceIndex);
    const sourceText = original?.node.eq(node)
      ? source.slice(original.start, original.end)
      : serializeBlock(node).replace(/\n/g, newline);

    if (index > 0) {
      const previous = originals[previousIndex ?? -1];
      const gap = original && previous && previousIndex !== null && sourceIndex === previousIndex + 1
        && original.node.type.name === node.type.name && previous.node.type.name === document.child(index - 1).type.name
        ? source.slice(previous.end, original.start)
        : newline + newline;
      content += gap;
    }
    if (node.type.name !== 'yaml_frontmatter') {
      blocks.push({ node, editorFrom, sourceFrom: content.length, sourceText });
    }
    content += sourceText;
    previousIndex = sourceIndex;
  });
  content += last ? source.slice(last.end) : document.eq(markdown.document) ? source : '';
  return { content, blocks };
}

function textRanges(block: BlockRange) {
  const ranges: { editor: number; source: number; size: number }[] = [];
  let searchFrom = 0;
  block.node.descendants((node, offset) => {
    if (node.type.name === 'wiki_link') {
      const raw = wikiSyntax(node.attrs.target, node.attrs.alias);
      let match = block.sourceText.indexOf(raw, searchFrom);
      const escaped = match < 0 && Boolean(node.attrs.alias);
      const syntax = escaped ? wikiSyntax(node.attrs.target, node.attrs.alias, true) : raw;
      if (escaped) match = block.sourceText.indexOf(syntax, searchFrom);
      if (match >= 0) {
        ranges.push({ editor: block.editorFrom + 1 + offset, source: block.sourceFrom + match, size: 0 });
        searchFrom = match + syntax.length;
        ranges.push({ editor: block.editorFrom + 2 + offset, source: block.sourceFrom + searchFrom, size: 0 });
      }
      return;
    }
    if (node.type.name === 'footnote_reference') {
      const syntax = `[^${node.attrs.id}]`;
      const match = block.sourceText.indexOf(syntax, searchFrom);
      if (match >= 0) {
        ranges.push({ editor: block.editorFrom + 1 + offset, source: block.sourceFrom + match, size: 0 });
        searchFrom = match + syntax.length;
        ranges.push({ editor: block.editorFrom + 2 + offset, source: block.sourceFrom + searchFrom, size: 0 });
      }
      return;
    }
    if (node.type.name === 'inline_math') {
      const latex = String(node.attrs.latex ?? '');
      const single = `$${latex}$`;
      const double = `$$${latex}$$`;
      let match = block.sourceText.indexOf(single, searchFrom);
      let syntaxLength = single.length;
      if (match < 0) {
        match = block.sourceText.indexOf(double, searchFrom);
        syntaxLength = double.length;
      }
      if (match >= 0) {
        ranges.push({ editor: block.editorFrom + 1 + offset, source: block.sourceFrom + match, size: 0 });
        searchFrom = match + syntaxLength;
        ranges.push({ editor: block.editorFrom + 2 + offset, source: block.sourceFrom + searchFrom, size: 0 });
      }
      return;
    }
    if (!node.isText || !node.text) return;
    const match = block.sourceText.indexOf(node.text, searchFrom);
    if (match < 0) return;
    ranges.push({ editor: block.editorFrom + 1 + offset, source: block.sourceFrom + match, size: node.text.length });
    searchFrom = match + node.text.length;
  });
  return ranges;
}

export function translatePosition(blocks: BlockRange[], position: number, from: 'editor' | 'source') {
  const to = from === 'editor' ? 'source' : 'editor';
  const checkpoints = blocks.flatMap((block) => {
    const start = { editor: block.editorFrom + 1, source: block.sourceFrom, size: 0 };
    return [start, ...textRanges(block)];
  });
  let nearest = 0;
  let distance = Infinity;
  for (const point of checkpoints) {
    const offset = Math.max(0, Math.min(position - point[from], point.size));
    const candidateDistance = Math.abs(position - point[from] - offset);
    if (candidateDistance < distance) {
      nearest = point[to] + offset;
      distance = candidateDistance;
    }
  }
  return nearest;
}
