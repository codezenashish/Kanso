import { tableNodes } from '@tiptap/pm/tables';
import { defaultMarkdownSerializer, MarkdownSerializer, schema as markdownSchema } from 'prosemirror-markdown';
import { Schema, type Mark, type Node as EditorNode } from 'prosemirror-model';
import { firstLineEnding, normalizeNewlines } from './source-newlines';
import { prepareWikiMarkdown, wikiLabel, wikiSyntax } from '@/lib/wiki-markdown';
import { parseNoteMarkdown, readLinkDefinitions, walkMarkdown, type MarkdownNode } from '@/lib/note-markdown';

const blockTypes = [
  'paragraph', 'heading', 'blockquote', 'horizontal_rule', 'code_block', 'bullet_list', 'ordered_list',
] as const;

let editorNodes = markdownSchema.spec.nodes.update('doc', { content: 'yaml_frontmatter? block+' });
for (const name of blockTypes) {
  const node = markdownSchema.nodes[name].spec;
  editorNodes = editorNodes.update(name, { ...node, attrs: { ...node.attrs, sourceIndex: { default: null } } });
}

const emptyTaskMarker = '\u200b';
const listItem = markdownSchema.nodes.list_item.spec;
const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (element) => element.getAttribute('data-align'),
      setDOMAttr: (value, attrs) => {
        if (value === 'left' || value === 'center' || value === 'right') {
          attrs['data-align'] = value;
          attrs.style = `text-align: ${value}`;
        }
      },
    },
  },
});

editorNodes = editorNodes.append({
  ...tables,
  table: { ...tables.table, attrs: { sourceIndex: { default: null } } },
}).update('heading', { ...editorNodes.get('heading')!, content: 'inline*' }).update('list_item', {
  ...listItem,
  attrs: { checked: { default: null } },
  parseDOM: [{ tag: 'li', getAttrs: (element) => ({
    checked: element.hasAttribute('data-task') ? element.getAttribute('data-task') === 'true' : null,
  }) }],
  toDOM(node) {
    if (node.attrs.checked === null) return ['li', 0];
    return ['li', { 'data-task': String(node.attrs.checked) },
      ['span', { contenteditable: 'false', class: 'grid h-lh place-items-center' },
        ['input', { type: 'checkbox', checked: node.attrs.checked ? '' : null, 'aria-label': 'Toggle task', class: 'size-4 cursor-pointer rounded-sm accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring' }]],
      ['div', { 'data-task-content': '', class: 'min-w-0' }, 0]];
  },
});

const linkMark = markdownSchema.marks.link.spec;
export const visualSchema = new Schema({
  nodes: editorNodes.addToEnd('wiki_link', {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { target: {}, alias: { default: null } },
    parseDOM: [{ tag: 'button[data-wiki-target]', getAttrs: (element) => ({
      target: element.getAttribute('data-wiki-target'), alias: element.getAttribute('data-wiki-alias'),
    }) }],
    toDOM: (node) => ['button', {
      type: 'button', 'data-wiki-target': node.attrs.target, 'data-wiki-alias': node.attrs.alias,
      contenteditable: 'false', title: wikiLabel(node.attrs.target),
    }, node.attrs.alias || wikiLabel(node.attrs.target)],
  }).addToEnd('inline_math', {
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    attrs: { latex: { default: '' } },
    parseDOM: [{
      tag: 'span[data-math-inline]',
      getAttrs: (element) => ({ latex: element.getAttribute('data-latex') ?? '' }),
    }],
    toDOM: (node) => [
      'span',
      { 'data-math-inline': '', 'data-latex': node.attrs.latex, contenteditable: 'false' },
      `$${node.attrs.latex}$`,
    ],
  }).addToEnd('math_block', {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: { latex: { default: '' }, sourceIndex: { default: null } },
    parseDOM: [{
      tag: 'div[data-math-block]',
      getAttrs: (element) => ({ latex: element.getAttribute('data-latex') ?? '' }),
    }],
    toDOM: (node) => [
      'div',
      { 'data-math-block': '', 'data-latex': node.attrs.latex, contenteditable: 'false' },
      `$$\n${node.attrs.latex}\n$$`,
    ],
  }).addToEnd('yaml_frontmatter', {
    atom: true,
    isolating: true,
    selectable: false,
    attrs: { source: {}, sourceIndex: { default: null } },
    toDOM: () => ['div', { hidden: '', contenteditable: 'false' }],
  }).addToEnd('preserved_markdown', {
    group: 'block',
    content: 'text*',
    code: true,
    defining: true,
    marks: '',
    attrs: { sourceIndex: { default: null } },
    parseDOM: [{ tag: 'pre[data-preserved-markdown]', priority: 60, preserveWhitespace: 'full' }],
    toDOM: () => ['pre', { 'data-preserved-markdown': '', 'aria-label': 'Markdown source block' }, 0],
  }),
  marks: markdownSchema.spec.marks.update('link', {
    ...linkMark,
    toDOM: (mark) => ['a', { ...mark.attrs, href: safeHref(mark.attrs.href) ? mark.attrs.href : null }],
  }).addToStart('underline', {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
    toDOM: () => ['u'],
  }).addToStart('strike', {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
    toDOM: () => ['s'],
  }),
});

export function safeHref(href: string) {
  try {
    return /^(?:https?:|mailto:|tel:)$/i.test(new URL(href, 'https://workspace.invalid').protocol);
  } catch {
    return false;
  }
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

const markdownNodes: MarkdownSerializer['nodes'] = {
  ...defaultMarkdownSerializer.nodes,
  wiki_link(state, node) {
    state.write(wikiSyntax(node.attrs.target, node.attrs.alias));
  },
  inline_math(state, node) {
    const latex = String(node.attrs.latex ?? '').replace(/\r?\n/g, ' ');
    if (latex) state.write(`$${latex}$`);
  },
  image(state, node) {
    const { src, alt, title } = node.attrs;
    state.write(`![${state.esc(alt ?? '')}](${markdownDestination(src)}${markdownTitle(title)})`);
  },
};

const markdownMarks: MarkdownSerializer['marks'] = {
  ...defaultMarkdownSerializer.marks,
  link: {
    open: '[',
    close: (_state, mark) => `](${markdownDestination(mark.attrs.href)}${markdownTitle(mark.attrs.title)})`,
    mixable: true,
  },
  underline: { open: '<u>', close: '</u>', mixable: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
};

const tableCellSerializer = new MarkdownSerializer({
  ...markdownNodes,
  hard_break(state) { state.write('<br>'); },
}, markdownMarks, { escapeExtraCharacters: /[<>&]/g });

const serializer = new MarkdownSerializer({
  ...markdownNodes,
  list_item(state, node) {
    if (node.attrs.checked !== null) {
      state.write(node.attrs.checked ? '[x] ' : '[ ] ');
      if (node.firstChild?.isTextblock && !node.firstChild.content.size) state.write('&#8203;');
    }
    state.renderContent(node);
  },
  table(state, node) {
    node.forEach((row, _offset, rowIndex) => {
      const values: string[] = [];
      const separators: string[] = [];
      row.forEach((cell) => {
        const inline = tableCellSerializer.serialize(visualSchema.nodes.doc.create(null, cell.firstChild));
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
}, markdownMarks, { escapeExtraCharacters: /[<>&|]/g });

export const serializeVisualDocument = (document: EditorNode) => serializer.serialize(document);

type MarkdownContext = ReturnType<typeof prepareWikiMarkdown> & { definitions: ReturnType<typeof readLinkDefinitions> };

function convertInline(children: MarkdownNode[], context: MarkdownContext, marks: readonly Mark[] = [], inTable = false): EditorNode[] {
  const editorInline: EditorNode[] = [];
  const { marks: types, nodes } = visualSchema;

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
          if (marker) editorInline.push(visualSchema.text(remaining.slice(0, marker), marks));
          editorInline.push(nodes.wiki_link.create({ target: link.target, alias: link.alias }, null, marks));
          remaining = remaining.slice(marker + link.end - link.start);
          offset = link.end;
        }
        if (remaining) editorInline.push(visualSchema.text(remaining, marks));
        break;
      }
      case 'inlineCode':
        if (child.value) editorInline.push(visualSchema.text(child.value, types.code.create().addToSet(marks)));
        break;
      case 'inlineMath': {
        const latex = normalizeNewlines(child.value).replace(/\n/g, ' ');
        editorInline.push(nodes.inline_math.create({ latex }, null, marks));
        break;
      }
      case 'emphasis':
      case 'strong':
      case 'delete': {
        const mark = types[child.type === 'emphasis' ? 'em' : child.type === 'delete' ? 'strike' : 'strong'].create();
        editorInline.push(...convertInline(child.children, context, mark.addToSet(marks), inTable));
        break;
      }
      case 'link':
      case 'linkReference': {
        const target = child.type === 'link' ? child : context.definitions.get(child.identifier);
        if (!target) throw new Error('Missing Markdown link definition');
        const link = types.link.create({ href: target.url, title: target.title });
        editorInline.push(...convertInline(child.children, context, link.addToSet(marks), inTable));
        break;
      }
      case 'image':
      case 'imageReference': {
        const target = child.type === 'image' ? child : context.definitions.get(child.identifier);
        if (!target) throw new Error('Missing Markdown image definition');
        editorInline.push(nodes.image.create({ src: target.url, alt: child.alt, title: target.title }, null, marks));
        break;
      }
      case 'break':
        editorInline.push(nodes.hard_break.create());
        break;
      case 'html': {
        if (inTable && /^<br\s*\/?>$/i.test(child.value)) {
          editorInline.push(nodes.hard_break.create());
          break;
        }
        const closingIndex = children.findIndex((sibling, siblingIndex) => (
          siblingIndex > index && sibling.type === 'html' && sibling.value.toLowerCase() === '</u>'
        ));
        if (child.value.toLowerCase() !== '<u>' || closingIndex === -1) throw new Error('Unsupported inline HTML');
        editorInline.push(...convertInline(children.slice(index + 1, closingIndex), context, types.underline.create().addToSet(marks), inTable));
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

function convertBlock(node: MarkdownNode, context: MarkdownContext, sourceIndex: number | null = null): EditorNode {
  const { nodes } = visualSchema;
  const attrs = { sourceIndex };
  switch (node.type) {
    case 'heading':
      return nodes.heading.createChecked({ ...attrs, level: node.depth }, convertInline(node.children, context));
    case 'paragraph': {
      const blockLatex = standaloneBlockMath(node, context);
      if (blockLatex !== null) {
        return nodes.math_block.create({ ...attrs, latex: normalizeNewlines(blockLatex) });
      }
      return nodes.paragraph.createChecked(attrs, convertInline(node.children, context));
    }
    case 'math':
      return nodes.math_block.create({ ...attrs, latex: normalizeNewlines(node.value) });
    case 'blockquote':
      return nodes.blockquote.createChecked(attrs, node.children.length ? node.children.map((child) => convertBlock(child, context)) : [nodes.paragraph.create()]);
    case 'code': {
      const params = [node.lang, node.meta].filter(Boolean).join(' ');
      if (params.includes('`')) throw new Error('Unsupported code fence info');
      return nodes.code_block.create({ ...attrs, params }, node.value ? visualSchema.text(node.value) : undefined);
    }
    case 'thematicBreak':
      return nodes.horizontal_rule.create(attrs);
    case 'list':
      return nodes[node.ordered ? 'ordered_list' : 'bullet_list'].createChecked(
        { ...attrs, order: node.start ?? 1, tight: !node.spread && node.children.every((item) => !item.spread) },
        node.children.map((item) => convertBlock(item, context)),
      );
    case 'listItem': {
      const children = node.children.map((child) => convertBlock(child, context));
      if (node.checked != null && children[0]?.textContent === emptyTaskMarker) children[0] = nodes.paragraph.create();
      return nodes.list_item.createChecked({ checked: node.checked ?? null }, children.length
        ? children : [nodes.paragraph.create()]);
    }
    case 'table': {
      const columnCount = node.children[0]?.children.length ?? 0;
      if (!columnCount || node.children.some((row) => row.children.length > columnCount)) throw new Error('Unsupported table shape');
      return nodes.table.createChecked(attrs, node.children.map((row, rowIndex) => nodes.table_row.create(
        null,
        Array.from({ length: columnCount }, (_, column) => (rowIndex === 0 ? nodes.table_header : nodes.table_cell).create(
          { align: node.align?.[column] ?? null },
          nodes.paragraph.create(null, convertInline(row.children[column]?.children ?? [], context, [], true)),
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

export function readVisualMarkdown(source: string): VisualMarkdown {
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
        if (part.type === 'text' && /\[\[|\[!|==[^\n]+==|%%|(?:^|\n):::|(?:^|\s)\^[\w-]+$/.test(part.value)) {
          throw new Error('Unsupported Markdown extension');
        }
      }
      node = block.type === 'yaml'
        ? visualSchema.nodes.yaml_frontmatter.create({ sourceIndex, source: normalizeNewlines(markdown) })
        : convertBlock(block, context, sourceIndex);
    } catch {
      const rawText = normalizeNewlines(markdown);
      node = visualSchema.nodes.preserved_markdown.create({ sourceIndex }, rawText ? visualSchema.text(rawText) : undefined);
    }
    return { node, start: from, end: to };
  });
  const document = visualSchema.nodes.doc.createAndFill(null, originals.map((block) => block.node))!;
  return { source, document, originals };
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
    if (index === 1 && document.childCount === 2 && document.firstChild?.type === visualSchema.nodes.yaml_frontmatter
      && node.type === visualSchema.nodes.paragraph && !node.content.size) return;
    const originalIndex: number | null = node.attrs.sourceIndex ?? null;
    const sourceIndex = originalIndex !== null && !usedOriginals.has(originalIndex) ? originalIndex : null;
    const original = sourceIndex === null ? undefined : originals[sourceIndex];
    if (sourceIndex !== null) usedOriginals.add(sourceIndex);
    const sourceText = original?.node.eq(node)
      ? source.slice(original.start, original.end)
      : serializeVisualDocument(visualSchema.nodes.doc.create(null, node)).replace(/\n/g, newline);

    if (index > 0) {
      const previous = originals[previousIndex ?? -1];
      const gap = original && previous && previousIndex !== null && sourceIndex === previousIndex + 1
        && original.node.type === node.type && previous.node.type === document.child(index - 1).type
        ? source.slice(previous.end, original.start)
        : newline + newline;
      content += gap;
    }
    if (node.type !== visualSchema.nodes.yaml_frontmatter) {
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
    if (node.type === visualSchema.nodes.wiki_link) {
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
    if (node.type === visualSchema.nodes.inline_math) {
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
