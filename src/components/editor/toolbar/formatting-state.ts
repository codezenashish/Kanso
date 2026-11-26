import type { Mark, Node, ResolvedPos, Schema } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { readVisualMarkdown, translatePosition, writeVisualMarkdown } from '../visual-markdown';

type ToggleState = boolean | 'mixed';
export type FormatToggle = 'bold' | 'italic' | 'underline' | 'strike' | 'highlight' | 'superscript' | 'subscript' | 'inlineCode' | 'inlineMath' | 'bulletList' | 'orderedList' | 'quote' | 'callout' | 'codeBlock';
type Marks = Partial<Record<FormatToggle, ToggleState>>;

export type FormattingState = { toggles: Marks; heading: string; link: boolean };
export const emptyFormatting: FormattingState = { toggles: {}, heading: '', link: false };

export function sameFormatting(first: FormattingState, second: FormattingState) {
  if (first === second) return true;
  if (first.heading !== second.heading || first.link !== second.link) return false;
  const toggles = Object.keys(first.toggles) as FormatToggle[];
  return toggles.length === Object.keys(second.toggles).length
    && toggles.every((toggle) => first.toggles[toggle] === second.toggles[toggle]);
}

function inlineMarksFor(schema: Schema) {
  return {
    bold: schema.marks.bold,
    italic: schema.marks.italic,
    underline: schema.marks.underline,
    strike: schema.marks.strike,
    highlight: schema.marks.highlight,
    superscript: schema.marks.superscript,
    subscript: schema.marks.subscript,
    inlineCode: schema.marks.code,
  };
}

function inlineStates(schema: Schema, groups: readonly (readonly Mark[])[], toggles: Marks) {
  const inlineMarks = inlineMarksFor(schema);
  for (const name of Object.keys(inlineMarks) as (keyof typeof inlineMarks)[]) {
    const count = groups.reduce((total, marks) => total + Number(Boolean(inlineMarks[name].isInSet(marks))), 0);
    if (count) toggles[name] = count === groups.length || 'mixed';
  }
}

function blockState(position: ResolvedPos, block: Node) {
  const { heading, paragraph, bulletList, orderedList, blockquote, callout, codeBlock } = block.type.schema.nodes;
  let list: typeof bulletList | typeof orderedList | undefined;
  let quote = false;
  let inCallout = false;
  for (let depth = position.depth; depth > 0; depth--) {
    const { type } = position.node(depth);
    if (!list && (type === bulletList || type === orderedList)) list = type;
    if (type === blockquote) quote = true;
    if (type === callout) inCallout = true;
  }
  return {
    heading: block.type === heading ? String(block.attrs.level) : block.type === paragraph ? '0' : '',
    bulletList: list === bulletList,
    orderedList: list === orderedList,
    quote,
    callout: inCallout,
    codeBlock: block.type === codeBlock,
  };
}

function readFormatting(document: Node, from: number, to: number, storedMarks?: readonly Mark[] | null): FormattingState {
  const schema = document.type.schema;
  const { preserved_markdown, inline_math, math_block } = schema.nodes;
  const cursor = document.resolve(from);
  if (cursor.parent.type === preserved_markdown) return emptyFormatting;
  const marks: (readonly Mark[])[] = [];
  const blocks: ReturnType<typeof blockState>[] = [];
  let hasMath = false;
  let hasNonMath = false;
  if (from === to) {
    marks.push(storedMarks ?? cursor.marks());
    blocks.push(blockState(cursor, cursor.parent));
  } else {
    document.nodesBetween(from, to, (node, position) => {
      if (node.type === inline_math || node.type === math_block) hasMath = true;
      else if (node.isText) hasNonMath = true;
      if (node.isInline) marks.push(node.marks);
      if (node.isTextblock && position + node.nodeSize - 1 >= from) {
        blocks.push(blockState(document.resolve(position + 1), node));
      }
    });
  }

  const toggles: Marks = {};
  inlineStates(schema, marks, toggles);
  if (hasMath) toggles.inlineMath = hasNonMath ? 'mixed' : true;
  for (const key of ['bulletList', 'orderedList', 'quote', 'callout', 'codeBlock'] as const) {
    const count = blocks.filter((block) => block[key]).length;
    if (count) toggles[key] = count === blocks.length || 'mixed';
  }
  const level = blocks[0]?.heading ?? '';
  return {
    toggles,
    heading: blocks.every((block) => block.heading === level) ? level : '',
    link: marks.length > 0 && marks.every((group) => Boolean(schema.marks.link.isInSet(group))),
  };
}

export function visualFormatting(state: EditorState) {
  return readFormatting(state.doc, state.selection.from, state.selection.to, state.storedMarks);
}

export function prepareSourceFormatting(source: string) {
  const markdown = readVisualMarkdown(source);
  return { markdown, blocks: writeVisualMarkdown(markdown, markdown.document).blocks };
}

export function sourceFormatting({ markdown, blocks }: ReturnType<typeof prepareSourceFormatting>, start: number, end: number) {
  const withinBody = markdown.originals.some(({ node, start: from, end: to }) =>
    node.type.name !== 'yaml_frontmatter' && start <= to && end >= from);
  if (!withinBody) return emptyFormatting;
  const from = translatePosition(blocks, start, 'source');
  const to = translatePosition(blocks, end, 'source');
  return readFormatting(markdown.document, Math.min(from, to), Math.max(from, to));
}
