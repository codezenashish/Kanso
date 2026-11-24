import { addRowAfter, goToNextCell, tableEditing } from '@tiptap/pm/tables';
import {
  baseKeymap, chainCommands, lift, setBlockType, toggleMark, wrapIn,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { Fragment } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, Plugin, Selection, type Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { slashCommandPlugin, type SlashMenuState } from './slash-menu';
import type { MarkdownAction } from './toolbar/markdown-toolbar';
import { serializeVisualDocument, visualSchema, type VisualMarkdown } from './visual-markdown';

const { nodes, marks } = visualSchema;
const toggleBold = toggleMark(marks.strong);
const toggleItalic = toggleMark(marks.em);

const splitChecklistItem: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const item = $from.depth > 1 ? $from.node(-1) : null;
  return item?.type === nodes.list_item && item.attrs.checked !== null
    && splitListItem(nodes.list_item, { checked: false })(state, dispatch);
};

const advanceTableCell = chainCommands(goToNextCell(1), (state, dispatch) => (
  addRowAfter(state, dispatch && ((transaction) => {
    goToNextCell(1)(state.apply(transaction), (next) => {
      transaction.setSelection(Selection.fromJSON(transaction.doc, next.selection.toJSON()));
    });
    dispatch(transaction.scrollIntoView());
  }))
));

export function createVisualState(markdown: VisualMarkdown, publishSlashMenu: (menu: SlashMenuState | null) => void) {
  return EditorState.create({
    doc: markdown.document,
    plugins: [
      history(),
      slashCommandPlugin(publishSlashMenu, editorCommand),
      new Plugin({
        props: {
          handleDOMEvents: {
            keydown(_view, event) {
              return event.target instanceof HTMLInputElement && event.target.type === 'checkbox';
            },
            change(view, event) {
              const checkbox = event.target;
              if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== 'checkbox') return false;
              const taskContent = checkbox.closest('[data-task]')?.querySelector('[data-task-content]');
              if (!taskContent) return false;

              const position = view.state.doc.resolve(view.posAtDOM(taskContent, 0));
              if (position.parent.type !== nodes.list_item || position.parent.attrs.checked === null) return false;
              view.dispatch(view.state.tr.setNodeMarkup(position.before(), undefined, {
                ...position.parent.attrs,
                checked: checkbox.checked,
              }));
              return true;
            },
          },
        },
      }),
      keymap({
        'Mod-z': undo,
        'Mod-Shift-z': redo,
        'Mod-y': redo,
        'Mod-b': toggleBold,
        'Mod-i': toggleItalic,
        Enter: chainCommands(splitChecklistItem, splitListItem(nodes.list_item)),
        Tab: chainCommands(advanceTableCell, sinkListItem(nodes.list_item)),
        'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(nodes.list_item)),
      }),
      keymap(baseKeymap),
      tableEditing(),
    ],
  });
}

function toggleList(type: typeof nodes.bullet_list): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const ancestor = $from.node(depth);
      if (depth > $to.depth || ancestor !== $to.node(depth)) continue;
      if (ancestor.type !== nodes.bullet_list && ancestor.type !== nodes.ordered_list) continue;
      if (ancestor.type === type) return liftListItem(nodes.list_item)(state, dispatch);
      dispatch?.(state.tr.setNodeMarkup($from.before(depth), type, { tight: ancestor.attrs.tight }).scrollIntoView());
      return true;
    }
    return wrapInList(type, { tight: true })(state, dispatch);
  };
}

function applyLink(href: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const mark = marks.link.create({ href });
    const transaction = empty
      ? state.tr.replaceSelectionWith(visualSchema.text(href, [mark]), false)
      : state.tr.addMark(from, to, mark);
    dispatch?.(transaction.scrollIntoView());
    return true;
  };
}

function selectionTouchesSourceBlock(state: EditorState) {
  const { from, to, $from } = state.selection;
  if ($from.parent.type === nodes.preserved_markdown) return true;
  let touchesSource = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type === nodes.preserved_markdown) touchesSource = true;
    return !touchesSource;
  });
  return touchesSource;
}

function editorCommand(action: MarkdownAction): Command {
  switch (action.type) {
    case 'undo': return undo;
    case 'redo': return redo;
    case 'bold': return toggleBold;
    case 'italic': return toggleItalic;
    case 'underline': return toggleMark(marks.underline);
    case 'strike': return toggleMark(marks.strike);
    case 'inlineCode': return toggleMark(marks.code);
    case 'bulletList': return toggleList(nodes.bullet_list);
    case 'orderedList': return toggleList(nodes.ordered_list);
    case 'heading': return action.level
      ? setBlockType(nodes.heading, { level: action.level })
      : setBlockType(nodes.paragraph);
    case 'codeBlock': return setBlockType(nodes.code_block);
    case 'quote': return (state, dispatch) => (
      Array.from({ length: state.selection.$from.depth }, (_, index) => state.selection.$from.node(index + 1)).some((ancestor) => ancestor.type === nodes.blockquote)
        ? lift(state, dispatch)
        : wrapIn(nodes.blockquote)(state, dispatch)
    );
    case 'link': return applyLink(action.href);
    case 'divider': return (state, dispatch) => {
      const { $to } = state.selection;
      const afterBlock = $to.depth ? $to.after(1) : $to.pos;
      dispatch?.(state.tr.insert(afterBlock, Fragment.fromArray([nodes.horizontal_rule.create(), nodes.paragraph.create()])).scrollIntoView());
      return true;
    };
  }
}

export function formatVisual(view: EditorView, action: MarkdownAction) {
  view.focus();
  if (action.type !== 'undo' && action.type !== 'redo' && selectionTouchesSourceBlock(view.state)) return;
  editorCommand(action)(view.state, view.dispatch, view);
}

export function copyVisualMarkdown(content: Fragment) {
  return serializeVisualDocument(nodes.doc.create(null, content));
}
