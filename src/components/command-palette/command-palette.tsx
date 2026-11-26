import { Dialog } from '@base-ui/react/dialog';
import { Command, FileText, Search, X } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { buildWorkspaceSearch } from '@/lib/workspace-search';
import { executeWorkspaceCommand, workspaceShortcutLabel, workspaceShortcuts, type WorkspaceCommand } from '@/lib/workspace-commands';

type PaletteEntry = {
  id: string;
  label: string;
  description?: string;
  keywords?: string;
  shortcut?: string;
  disabled?: boolean;
  priority: number;
  lastOpenedAt?: number;
  kind: 'note' | 'command';
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
  commands: WorkspaceCommand[];
  notes: ReturnType<typeof buildWorkspaceSearch>['notes'];
  openIds: string[];
  onOpenNote: (id: string) => void;
};

const resultLimit = 60;

function normalized(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function fuzzyScore(text: string, term: string) {
  if (text === term) return 0;
  const position = text.indexOf(term);
  if (position >= 0) return position === 0 ? 1 : 3 + Math.min(position, 12);
  let end = -1;
  let start = -1;
  for (const character of term) {
    end = text.indexOf(character, end + 1);
    if (end < 0) return Infinity;
    if (start < 0) start = end;
  }
  return 24 + Math.min(end - start + 1 - term.length, 30) + Math.min(start, 10);
}

function entryScore(entry: PaletteEntry, terms: string[]) {
  const title = normalized(entry.label);
  const details = normalized([entry.description, entry.keywords].filter(Boolean).join(' '));
  return terms.reduce((score, term) => score + Math.min(fuzzyScore(title, term), 10 + fuzzyScore(details, term)), 0);
}

export function CommandPalette({ open, onOpenChange, returnFocus, commands, notes, openIds, onOpenNote }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pending = useRef<(() => void) | null>(null);
  const listId = useId();
  const commandsOnly = query.trimStart().startsWith('>');
  const entries = useMemo(() => {
    if (!open) return [];
    const trimmed = query.trimStart();
    const terms = normalized(commandsOnly ? trimmed.slice(1).trim() : trimmed.trim()).split(/\s+/).filter(Boolean);
    const commandEntries: PaletteEntry[] = commands.map((command) => ({
      id: `command:${command.id}`, kind: 'command', label: command.label, keywords: command.keywords,
      shortcut: command.shortcut, priority: 2, disabled: command.available ? !command.available() : false,
      run: () => { executeWorkspaceCommand(command); },
    }));
    const tabs = new Set(openIds);
    const noteEntries: PaletteEntry[] = [];
    if (!commandsOnly) {
      for (const [id, { note, path, archived }] of notes) {
        const isOpen = tabs.has(id);
        if (archived && !isOpen) continue;
        if (!terms.length && !isOpen && !note.lastOpenedAt) continue;
        noteEntries.push({
          id: `note:${id}`, kind: 'note', label: note.name,
          description: [path || 'Workspace', archived ? 'Archived' : '', isOpen ? 'Open tab' : ''].filter(Boolean).join(' · '),
          priority: isOpen ? 0 : note.lastOpenedAt ? 1 : 3, lastOpenedAt: note.lastOpenedAt,
          run: () => onOpenNote(id),
        });
      }
    }
    return [...noteEntries, ...commandEntries].map((entry) => ({ entry, score: entryScore(entry, terms) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((first, second) => first.score - second.score || first.entry.priority - second.entry.priority
        || (second.entry.lastOpenedAt ?? 0) - (first.entry.lastOpenedAt ?? 0)
        || first.entry.label.localeCompare(second.entry.label))
      .slice(0, resultLimit).map(({ entry }) => entry);
  }, [open, query, commandsOnly, commands, notes, openIds, onOpenNote]);

  const enabled = entries.filter((entry) => !entry.disabled);
  const selected = enabled.find(({ id }) => id === highlighted) ?? enabled[0];
  const optionId = (id: string) => `${listId}-${id}`;

  useLayoutEffect(() => {
    const active = list.current?.querySelector('[aria-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [selected?.id]);

  function select(entry: PaletteEntry | undefined) {
    if (!entry || entry.disabled) return;
    pending.current = entry.run;
    onOpenChange(false);
  }

  function handleSearchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      select(selected);
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && selected) {
      event.preventDefault();
      const index = enabled.indexOf(selected);
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      setHighlighted(enabled[next].id);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(nextOpen) => {
      if (nextOpen) return;
      setQuery('');
      setHighlighted(undefined);
      const run = pending.current;
      pending.current = null;
      // Let the dialog restore focus and release the workspace before running the command.
      if (run) requestAnimationFrame(run);
    }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-foreground/25" />
        <Dialog.Popup initialFocus={input} finalFocus={() => returnFocus.current?.isConnected ? returnFocus.current : true}
          className="fixed inset-x-3 top-[min(15dvh,7rem)] z-50 mx-auto flex max-h-[min(70dvh,36rem)] max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">Search notes and commands. Type &gt; for commands only. Use arrow keys and Enter to select.</Dialog.Description>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input ref={input} role="combobox" aria-label="Search notes and commands" aria-expanded={open}
              aria-controls={listId} aria-autocomplete="list" aria-activedescendant={selected ? optionId(selected.id) : undefined}
              className="min-h-9 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Search notes and commands" value={query} onKeyDown={handleSearchKeys}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(undefined);
                if (list.current) list.current.scrollTop = 0;
              }} />
            <Dialog.Close render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Close command palette" />}>
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <ul id={listId} ref={list} role="listbox" aria-label={commandsOnly ? 'Commands' : 'Notes and commands'}
            className="min-h-0 flex-1 overflow-y-auto p-1">
            {entries.map((entry) => {
              const Icon = entry.kind === 'note' ? FileText : Command;
              return (
                <li key={entry.id} id={optionId(entry.id)} role="option"
                  aria-selected={selected?.id === entry.id} aria-disabled={entry.disabled || undefined}
                  className={cn('flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-sm',
                    entry.disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
                    selected?.id === entry.id && 'bg-accent text-accent-foreground')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(entry)}>
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{entry.label}</div>
                    {entry.description && <div className="truncate text-xs text-muted-foreground">{entry.description}</div>}
                  </div>
                  {entry.shortcut && <kbd className="shrink-0 rounded border border-border px-1 text-xs text-muted-foreground">{workspaceShortcutLabel(entry.shortcut)}</kbd>}
                </li>
              );
            })}
          </ul>
          {entries.length === 0 && <p role="status" className="px-3 py-3 text-sm text-muted-foreground">No matching notes or commands.</p>}
          <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span><kbd>↑ ↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span>
            <span className="ms-auto"><kbd>{workspaceShortcutLabel(workspaceShortcuts.palette)}</kbd> · <kbd>&gt;</kbd> Commands</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
