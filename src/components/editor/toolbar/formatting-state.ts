import type { Mark, Node, ResolvedPos } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { readVisualMarkdown, translatePosition, visualSchema, writeVisualMarkdown } from '../visual-markdown';

type ToggleState = boolean | 'mixed';
export type FormatToggle = 'bold' | 'italic' | 'underline' | 'strike' | 'inlineCode' | 'inlineMath' | 'bulletList' | 'orderedList' | 'quote' | 'codeBlock';
type Marks = Partial<Record<FormatToggle, ToggleState>>;

export type FormattingState = { toggles: Marks; heading: string; link: boolean };
export const emptyFormatting: FormattingState = { toggles: {}, heading: '', link: false };

const inlineMarks = {
  bold: visualSchema.marks.strong,
  italic: visualSchema.marks.em,
  underline: visualSchema.marks.underline,
  strike: visualSchema.marks.strike,
  inlineCode: visualSchema.marks.code,
};
const { heading, paragraph, bullet_list, ordered_list, blockquote, code_block, preserved_markdown, inline_math, math_block } = visualSchema.nodes;

function inlineStates(groups: readonly (readonly Mark[])[], toggles: Marks) {
  for (const name of Object.keys(inlineMarks) as (keyof typeof inlineMarks)[]) {
    const count = groups.reduce((total, marks) => total + Number(Boolean(inlineMarks[name].isInSet(marks))), 0);
    if (count) toggles[name] = count === groups.length || 'mixed';
  }
}

function blockState(position: ResolvedPos, block: Node) {
  let list: typeof bullet_list | typeof ordered_list | undefined;
  let quote = false;
  for (let depth = position.depth; depth > 0; depth--) {
    const { type } = position.node(depth);
    if (!list && (type === bullet_list || type === ordered_list)) list = type;
    if (type === blockquote) quote = true;
  }
  return {
    heading: block.type === heading ? String(block.attrs.level) : block.type === paragraph ? '0' : '',
    bulletList: list === bullet_list,
    orderedList: list === ordered_list,
    quote,
    codeBlock: block.type === code_block,
  };
}

function readFormatting(document: Node, from: number, to: number, storedMarks?: readonly Mark[] | null): FormattingState {
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
  inlineStates(marks, toggles);
  if (hasMath) toggles.inlineMath = hasNonMath ? 'mixed' : true;
  for (const key of ['bulletList', 'orderedList', 'quote', 'codeBlock'] as const) {
    const count = blocks.filter((block) => block[key]).length;
    if (count) toggles[key] = count === blocks.length || 'mixed';
  }
  const level = blocks[0]?.heading ?? '';
  return {
    toggles,
    heading: blocks.every((block) => block.heading === level) ? level : '',
    link: marks.length > 0 && marks.every((group) => Boolean(visualSchema.marks.link.isInSet(group))),
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
    node.type !== visualSchema.nodes.yaml_frontmatter && start <= to && end >= from);
  if (!withinBody) return emptyFormatting;
  const from = translatePosition(blocks, start, 'source');
  const to = translatePosition(blocks, end, 'source');
  return readFormatting(markdown.document, Math.min(from, to), Math.max(from, to));
}
