import { lift, setBlockType, toggleMark, wrapIn } from '@tiptap/pm/commands';
import { redo, undo } from '@tiptap/pm/history';
import { Fragment } from '@tiptap/pm/model';
import { liftListItem, wrapInList } from '@tiptap/pm/schema-list';
import { NodeSelection, type Command, type EditorState } from '@tiptap/pm/state';
import { applyCalloutCommand } from '../callout-visual';
import { insertFootnoteCommand } from '../footnote-visual';
import { mathEditorMetaKey, type MathEditorIntent } from '../math-visual';
import { insertMermaidCommand } from '../mermaid-visual';
import type { MarkdownAction } from '../toolbar/markdown-toolbar';

function toggleList(listName: 'bulletList' | 'orderedList'): Command {
  return (state, dispatch) => {
    const { bulletList, orderedList, listItem } = state.schema.nodes;
    const type = listName === 'bulletList' ? bulletList : orderedList;
    const { $from, $to } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const ancestor = $from.node(depth);
      if (depth > $to.depth || ancestor !== $to.node(depth)) continue;
      if (ancestor.type !== bulletList && ancestor.type !== orderedList) continue;
      if (ancestor.type === type) return liftListItem(listItem)(state, dispatch);
      dispatch?.(state.tr.setNodeMarkup($from.before(depth), type, { tight: ancestor.attrs.tight }).scrollIntoView());
      return true;
    }
    return wrapInList(type, { tight: true })(state, dispatch);
  };
}

function applyLink(href: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const mark = state.schema.marks.link.create({ href });
    const transaction = empty
      ? state.tr.replaceSelectionWith(state.schema.text(href, [mark]), false)
      : state.tr.addMark(from, to, mark);
    dispatch?.(transaction.scrollIntoView());
    return true;
  };
}

export function selectionTouchesSourceBlock(state: EditorState) {
  const preservedMarkdown = state.schema.nodes.preserved_markdown;
  const { from, to, $from } = state.selection;
  if ($from.parent.type === preservedMarkdown) return true;
  let touchesSource = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type === preservedMarkdown) touchesSource = true;
    return !touchesSource;
  });
  return touchesSource;
}

export function editorCommand(action: MarkdownAction): Command {
  switch (action.type) {
    case 'undo': return undo;
    case 'redo': return redo;
    case 'bold': return (state, dispatch) => toggleMark(state.schema.marks.bold)(state, dispatch);
    case 'italic': return (state, dispatch) => toggleMark(state.schema.marks.italic)(state, dispatch);
    case 'underline': return (state, dispatch) => toggleMark(state.schema.marks.underline)(state, dispatch);
    case 'strike': return (state, dispatch) => toggleMark(state.schema.marks.strike)(state, dispatch);
    case 'highlight': return (state, dispatch) => toggleMark(state.schema.marks.highlight)(state, dispatch);
    case 'superscript': return (state, dispatch) => toggleMark(state.schema.marks.superscript)(state, dispatch);
    case 'subscript': return (state, dispatch) => toggleMark(state.schema.marks.subscript)(state, dispatch);
    case 'inlineCode': return (state, dispatch) => toggleMark(state.schema.marks.code)(state, dispatch);
    case 'inlineMath':
    case 'mathBlock':
      return (state, dispatch) => {
        const { inline_math, math_block } = state.schema.nodes;
        const { selection } = state;
        if (
          selection instanceof NodeSelection
          && (selection.node.type === inline_math || selection.node.type === math_block)
        ) {
          dispatch?.(state.tr.setMeta(mathEditorMetaKey, {
            type: 'editNode',
            pos: selection.from,
          } satisfies MathEditorIntent));
          return true;
        }
        const mode = action.type === 'mathBlock' ? 'block' : 'inline';
        const initialLatex = selection.empty
          ? ''
          : state.doc.textBetween(selection.from, selection.to, mode === 'block' ? '\n' : ' ');
        dispatch?.(state.tr.setMeta(mathEditorMetaKey, {
          type: 'insert',
          mode,
          from: selection.from,
          to: selection.to,
          initialLatex,
        } satisfies MathEditorIntent));
        return true;
      };
    case 'bulletList': return toggleList('bulletList');
    case 'orderedList': return toggleList('orderedList');
    case 'heading': return (state, dispatch) => (
      action.level
        ? setBlockType(state.schema.nodes.heading, { level: action.level })(state, dispatch)
        : setBlockType(state.schema.nodes.paragraph)(state, dispatch)
    );
    case 'codeBlock': return (state, dispatch) => {
      const { codeBlock, paragraph } = state.schema.nodes;
      return setBlockType(state.selection.$from.parent.type === codeBlock ? paragraph : codeBlock)(state, dispatch);
    };
    case 'quote': return (state, dispatch) => {
      const { blockquote } = state.schema.nodes;
      return Array.from({ length: state.selection.$from.depth }, (_, index) => state.selection.$from.node(index + 1))
        .some((ancestor) => ancestor.type === blockquote)
        ? lift(state, dispatch)
        : wrapIn(blockquote)(state, dispatch);
    };
    case 'callout': return applyCalloutCommand(action.kind);
    case 'footnote': return insertFootnoteCommand;
    case 'mermaid': return insertMermaidCommand;
    case 'link': return applyLink(action.href);
    case 'divider': return (state, dispatch) => {
      const { horizontalRule, paragraph } = state.schema.nodes;
      const { $to } = state.selection;
      const afterBlock = $to.depth ? $to.after(1) : $to.pos;
      dispatch?.(state.tr.insert(afterBlock, Fragment.fromArray([horizontalRule.create(), paragraph.create()])).scrollIntoView());
      return true;
    };
  }
}
