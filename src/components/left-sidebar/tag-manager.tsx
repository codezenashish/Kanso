import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { tagKey, validTagName } from '@/lib/note-tags';
import type { useWorkspace } from '@/hooks/use-workspace';

const field = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring';

export function TagManager({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [newName, setNewName] = useState('');
  const [action, setAction] = useState<'rename' | 'merge' | 'remove'>('rename');
  const [target, setTarget] = useState('');

  const tags = [...workspace.tagCatalog.values()].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = tags.filter((tag) => tag.key.includes(tagKey(query)));
  const current = workspace.tagCatalog.get(selected);
  const notes = current ? [...workspace.searchIndex.notes.values()].filter(({ tags }) =>
    tags.some((name) => tagKey(name) === current.key)) : [];
  const canChange = !workspace.loading && workspace.saveStatus !== 'conflict' && workspace.saveStatus !== 'unavailable';

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canChange || !validTagName(newName)) return;
    if (workspace.mutateTags({ kind: 'create', name: newName })) setNewName('');
  }

  function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canChange || !current || (action !== 'remove' && !validTagName(target))) return;
    const count = current.active + current.archived + current.trashed;
    const label = action === 'remove' ? `Remove “${current.name}”`
      : action === 'merge' ? `Merge “${current.name}” into “${target.trim()}”` : `Rename “${current.name}” to “${target.trim()}”`;
    if (!window.confirm(`${label}? This affects ${count} notes, including ${current.archived} archived and ${current.trashed} in Trash.`)) return;
    if (workspace.mutateTags({ kind: action, source: current.key, name: action === 'remove' ? undefined : target })) {
      setSelected(action === 'remove' ? '' : tagKey(target));
      setTarget('');
    }
  }

  return (
    <div className="space-y-3 px-1">
      <input type="search" aria-label="Search tags" placeholder="Search tags" value={query} className={field}
        onChange={(event) => setQuery(event.target.value)} />
      <ul aria-label="Workspace tags" className="space-y-0.5">
        {filtered.map((tag) => (
          <li key={tag.key}>
            <button type="button" aria-pressed={selected === tag.key}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-sidebar-ring aria-pressed:bg-sidebar-accent"
              onClick={() => { setSelected(tag.key); setTarget(''); }}>
              <span className="truncate">{tag.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{tag.active + tag.archived} notes</span>
            </button>
          </li>
        ))}
      </ul>
      {!filtered.length && <p role="status" className="text-xs text-muted-foreground">{tags.length ? 'No matching tags.' : 'No tags yet.'}</p>}
      <form className="flex items-center gap-1" onSubmit={create}>
        <input aria-label="New tag name" placeholder="New tag name" className={field} value={newName} onChange={(event) => setNewName(event.target.value)} />
        <Button size="xs" type="submit" disabled={!canChange || !validTagName(newName)}>Create tag</Button>
      </form>
      {current && (
        <section aria-label="Tagged notes" className="space-y-2 border-t border-sidebar-border pt-2">
          <div className="flex items-center justify-between gap-1">
            <h3 className="truncate text-sm font-medium">{current.name}</h3>
            <Button type="button" size="xs" variant="ghost" onClick={() => { setSelected(''); setTarget(''); }}>Clear filter</Button>
          </div>
          {notes.length ? (
            <ul className="space-y-0.5">
              {notes.map(({ note, path, archived }) => (
                <li key={note.id}>
                  <button type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-sidebar-ring"
                    aria-current={workspace.activeNode?.id === note.id ? 'page' : undefined} onClick={() => workspace.openFile(note.id)}>
                    <span className="block truncate">{note.name}</span>
                    {(path || archived) && <span className="block truncate text-xs text-muted-foreground">{[path, archived ? 'Archived' : ''].filter(Boolean).join(' · ')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p role="status" className="text-xs text-muted-foreground">No active or archived notes use this tag.</p>}
          {current.trashed > 0 && <p className="text-xs text-muted-foreground">{current.trashed} in Trash</p>}
          <form className="space-y-1" onSubmit={change}>
            <Select aria-label="Tag action" className={field} value={action} options={[
              { value: 'rename', label: 'Rename tag' }, { value: 'merge', label: 'Merge tag' }, { value: 'remove', label: 'Remove tag' },
            ]} onValueChange={(value) => { if (value === 'rename' || value === 'merge' || value === 'remove') { setAction(value); setTarget(''); } }} />
            {action === 'rename' && <input aria-label="Rename to" placeholder="Rename to" className={field}
              value={target} onChange={(event) => setTarget(event.target.value)} />}
            {action === 'merge' && <Select aria-label="Merge into" className={field} value={target} options={[
              { value: '', label: 'Choose a tag' }, ...tags.filter((tag) => tag.key !== current.key).map((tag) => ({ value: tag.name, label: tag.name })),
            ]} onValueChange={setTarget} />}
            <Button type="submit" size="xs" variant="outline" disabled={!canChange || (action !== 'remove' && !validTagName(target))}>Review change</Button>
          </form>
        </section>
      )}
    </div>
  );
}
