import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CheckSquare, Code2, CornerDownLeft, Heading1, Heading2, Heading3, List, ListOrdered, Minus, Quote, Search, Table2, Type } from 'lucide-react';
import { Plugin, Selection, TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { closeHistory } from 'prosemirror-history';
import { cn } from '@/lib/utils';
import type { MarkdownAction } from './toolbar/markdown-toolbar';

const commands = [
  { id: 'text', keywords: 'paragraph', title: 'Text', description: 'Start writing with plain text', icon: Type, action: { type: 'heading', level: 0 } },
  { id: 'heading-1', title: 'Heading 1', description: 'Big section heading', icon: Heading1, action: { type: 'heading', level: 1 } },
  { id: 'heading-2', title: 'Heading 2', description: 'Medium section heading', icon: Heading2, action: { type: 'heading', level: 2 } },
  { id: 'heading-3', title: 'Heading 3', description: 'Small section heading', icon: Heading3, action: { type: 'heading', level: 3 } },
  { id: 'bullet', title: 'Bullet List', description: 'Create a simple bulleted list', icon: List, action: { type: 'bulletList' } },
  { id: 'numbered', title: 'Numbered List', description: 'Create a numbered list', icon: ListOrdered, action: { type: 'orderedList' } },
  { id: 'checklist', title: 'Checklist', description: 'Track tasks with checkboxes', icon: CheckSquare },
  { id: 'quote', title: 'Quote', description: 'Highlight a quote or important text', icon: Quote, action: { type: 'quote' } },
  { id: 'code', title: 'Code Block', description: 'Add a block of preformatted code', icon: Code2, action: { type: 'codeBlock' } },
  { id: 'table', title: 'Table', description: 'Insert a table to organize data', icon: Table2 },
  { id: 'divider', title: 'Divider', description: 'Add a horizontal divider', icon: Minus },
] as const;

type SlashCommand = (typeof commands)[number];
type SlashMatch = { from: number; to: number; query: string };

export type SlashMenuState = {
  query: string;
  results: SlashCommand[];
  search: (value: string) => void;
  handleKey: (event: KeyboardEvent) => boolean;
  onSearchBlur: () => void;
  selected: number;
  left: number;
  edge: number;
  above: boolean;
  availableHeight: number;
  choose: (command: SlashCommand) => void;
};

const listId = 'editor-slash-commands';
const menuId = 'editor-slash-menu';

function findMatch(view: EditorView): SlashMatch | null {
  const { selection, schema, storedMarks } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty || view.composing) return null;
  const { $from } = selection;
  const { paragraph, heading } = schema.nodes;
  if ($from.depth !== 1 || ($from.parent.type !== paragraph && $from.parent.type !== heading)) return null;
  const forbidden = [schema.marks.link, schema.marks.code];
  if ([...$from.marks(), ...(storedMarks ?? []), ...($from.nodeAfter?.marks ?? [])].some((mark) => forbidden.includes(mark.type))) return null;

  const prefix = $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc');
  const match = /^\/([\p{L}\p{N} -]*)$/u.exec(prefix);
  if (!match) return null;
  let forbiddenContent = false;
  $from.parent.nodesBetween(0, $from.parentOffset, (node) => {
    if (node.marks.some((mark) => forbidden.includes(mark.type))) forbiddenContent = true;
  });
  return forbiddenContent ? null : { from: $from.start(), to: $from.pos, query: match[1] };
}

function insertCommand(view: EditorView, match: SlashMatch, command: SlashCommand, runCommand: (action: MarkdownAction) => Command) {
  const { state } = view;
  const { nodes } = state.schema;
  const transaction = closeHistory(state.tr.delete(match.from, match.to));
  transaction.setSelection(TextSelection.create(transaction.doc, match.from));

  if ('action' in command) {
    const withoutQuery = state.apply(transaction);
    runCommand(command.action)(withoutQuery, (formatted) => {
      formatted.steps.forEach((step) => transaction.step(step));
      transaction.setSelection(Selection.fromJSON(transaction.doc, formatted.selection.toJSON()));
      transaction.setStoredMarks(formatted.storedMarks);
    });
  } else {
    const cursor = transaction.selection.$from;
    const paragraph = nodes.paragraph.create();
    const from = cursor.before();
    const to = cursor.after();
    const remaining = cursor.parent.content.size ? [cursor.parent] : [];

    if (command.id === 'checklist') {
      const item = nodes.list_item.create({ checked: false }, paragraph);
      transaction.replaceWith(from, to, [nodes.bullet_list.create({ tight: true }, item), ...remaining]);
      transaction.setSelection(TextSelection.create(transaction.doc, from + 3));
    } else if (command.id === 'table') {
      const header = nodes.table_row.create(null, Array.from({ length: 2 }, () => nodes.table_header.create(null, paragraph)));
      const body = nodes.table_row.create(null, Array.from({ length: 2 }, () => nodes.table_cell.create(null, paragraph)));
      transaction.replaceWith(from, to, [nodes.table.create(null, [header, body]), ...remaining]);
      transaction.setSelection(TextSelection.create(transaction.doc, from + 4));
    } else {
      transaction.replaceWith(from, to, [nodes.horizontal_rule.create(), ...(remaining.length ? remaining : [paragraph])]);
      transaction.setSelection(TextSelection.create(transaction.doc, from + 2));
    }
  }
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

export function slashCommandPlugin(publish: (menu: SlashMenuState | null) => void, runCommand: (action: MarkdownAction) => Command) {
  let selected = 0;
  let current: SlashMatch | null = null;
  let results: SlashCommand[] = [];
  let dismissed = false;

  function sync(view: EditorView) {
    const match = findMatch(view);
    if (!match) dismissed = false;
    const document = view.dom.ownerDocument;
    const searchFocused = document.getElementById(menuId)?.contains(document.activeElement);
    if (!match || dismissed || (!view.hasFocus() && !searchFocused)) {
      current = null;
      publish(null);
      view.dom.removeAttribute('aria-controls');
      view.dom.removeAttribute('aria-activedescendant');
      return;
    }
    if (current?.query !== match.query || current.from !== match.from) {
      selected = 0;
      results = commands.filter((command) => (
        `${command.title} ${command.description} ${'keywords' in command ? command.keywords : ''}`.toLowerCase().includes(match.query.trim().toLowerCase())
      ));
    }
    current = match;

    const caret = view.coordsAtPos(match.to);
    const height = view.dom.ownerDocument.documentElement.clientHeight;
    const spaceBelow = height - caret.bottom;
    const rootStyles = view.dom.ownerDocument.defaultView?.getComputedStyle(view.dom.ownerDocument.documentElement);
    const menuHeight = parseFloat(rootStyles?.fontSize ?? '16px') * 32;
    const above = spaceBelow < menuHeight && spaceBelow < caret.top;
    const active = results[selected];
    view.dom.setAttribute('aria-controls', listId);
    if (active) view.dom.setAttribute('aria-activedescendant', `${listId}-${active.id}`);
    else view.dom.removeAttribute('aria-activedescendant');
    publish({
      query: match.query, results, selected, left: caret.left, above,
      search(value) {
        if (!current) return;
        const { from, to } = current;
        const query = value.replace(/[^\p{L}\p{N} -]/gu, '');
        if (query === current.query) return;
        const transaction = view.state.tr.insertText(query, from + 1, to);
        transaction.setSelection(TextSelection.create(transaction.doc, from + 1 + query.length));
        view.dispatch(transaction);
      },
      handleKey: (event) => handleKey(view, event),
      onSearchBlur: () => scheduleSync(view),
      edge: above ? height - caret.top : caret.bottom,
      availableHeight: Math.max(0, above ? caret.top : spaceBelow),
      choose(command) {
        if (!current) return;
        insertCommand(view, current, command, runCommand);
      },
    });
  }

  function handleKey(view: EditorView, event: KeyboardEvent) {
    if (!current || event.isComposing || view.composing) return false;
    if (event.key === 'Escape') {
      dismissed = true;
      view.focus();
      sync(view);
      return true;
    }
    if (event.key === 'Enter') {
      if (results[selected]) insertCommand(view, current, results[selected], runCommand);
      return true;
    }
    if (!results.length || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return false;
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    selected = (selected + direction + results.length) % results.length;
    sync(view);
    return true;
  }

  function scheduleSync(view: EditorView) {
    queueMicrotask(() => { if (!view.isDestroyed) sync(view); });
  }

  return new Plugin({
    props: {
      handleKeyDown: handleKey,
      handleDOMEvents: {
        focus(view) { scheduleSync(view); return false; },
        blur(view) { scheduleSync(view); return false; },
      },
    },
    view(view) {
      const browser = view.dom.ownerDocument.defaultView;
      const positionMenu = () => { if (current) sync(view); };
      browser?.addEventListener('resize', positionMenu);
      browser?.addEventListener('scroll', positionMenu, true);
      return {
        update: sync,
        destroy() {
          current = null;
          dismissed = false;
          browser?.removeEventListener('resize', positionMenu);
          browser?.removeEventListener('scroll', positionMenu, true);
          publish(null);
        },
      };
    },
  });
}

export function SlashMenu({ menu }: { menu: SlashMenuState }) {
  const selectedRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [menu.selected, menu.results]);

  return createPortal(
    <div
      id={menuId}
      className="fixed z-30 flex w-(--slash-menu-width) max-w-[calc(100dvw-2*var(--spacing))] flex-col overflow-hidden rounded-2xl border border-border bg-popover font-sans font-normal text-popover-foreground shadow-lg [--slash-menu-width:--spacing(112)] supports-backdrop-filter:bg-popover/75 supports-backdrop-filter:backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100"
      style={{
        left: `clamp(var(--spacing), ${menu.left}px, calc(100dvw - min(var(--slash-menu-width), 100dvw - 2 * var(--spacing)) - var(--spacing)))`,
        [menu.above ? 'bottom' : 'top']: `calc(${menu.edge}px + var(--spacing))`,
        maxHeight: `clamp(0px, calc(${menu.availableHeight}px - var(--spacing) * 2), calc(var(--spacing) * 128))`,
      }}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3 text-muted-foreground focus-within:text-popover-foreground">
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <input
          role="combobox"
          aria-label="Search commands"
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={menu.results[menu.selected] ? `${listId}-${menu.results[menu.selected].id}` : undefined}
          placeholder="Search commands..."
          className="min-w-0 flex-1 rounded-sm bg-transparent text-sm text-popover-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
          value={menu.query}
          onChange={(event) => menu.search(event.target.value)}
          onBlur={menu.onSearchBlur}
          onKeyDown={(event) => {
            if (!menu.handleKey(event.nativeEvent)) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Insert a block"
        className="min-h-0 overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]"
        onMouseDown={(event) => event.preventDefault()}
      >
        {menu.results.length ? menu.results.map((command, index) => (
          <div
            key={command.id}
            ref={index === menu.selected ? selectedRef : undefined}
            id={`${listId}-${command.id}`}
            role="option"
            aria-selected={index === menu.selected}
            className={cn('grid cursor-pointer grid-cols-[--spacing(7)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-accent/70',
              index === menu.selected && 'bg-accent/80 text-accent-foreground')}
            onClick={() => menu.choose(command)}
          >
            <command.icon aria-hidden="true" className="size-4 justify-self-center opacity-85" />
            <div className="min-w-0">
              <div className="text-sm leading-tight">{command.title}</div>
              <div className="text-xs leading-snug text-muted-foreground">{command.description}</div>
            </div>
            {index === menu.selected && <CornerDownLeft aria-hidden="true" className="size-4 text-muted-foreground" />}
          </div>
        )) : <p role="status" className="px-3 py-2 text-sm text-muted-foreground">No matching commands.</p>}
      </div>
    </div>,
    document.body,
  );
}
