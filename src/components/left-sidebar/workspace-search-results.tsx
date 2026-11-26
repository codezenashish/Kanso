import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { searchWorkspace, type buildWorkspaceSearch, type SearchFilters, type SearchRange, type SearchResult } from '@/lib/workspace-search';

type SearchResultsProps = {
  index: ReturnType<typeof buildWorkspaceSearch>;
  query: string;
  filters: SearchFilters;
  onChangeFilters: (filters: SearchFilters) => void;
  onOpen: (result: SearchResult) => boolean;
};

const pageSize = 40;
const filterClass = 'h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring';

function highlight(text: string, range?: SearchRange): ReactNode {
  if (!range) return text;
  return (
    <>
      {text.slice(0, range.start)}
      <mark className="rounded-sm bg-sidebar-accent px-px text-sidebar-accent-foreground underline">{text.slice(range.start, range.end)}</mark>
      {text.slice(range.end)}
    </>
  );
}

function snippet(content: string, { start, end }: SearchRange) {
  const left = Math.max(0, start - 32);
  const right = Math.min(content.length, end + 48);
  const prefix = left > 0 ? '…' : '';
  const suffix = right < content.length ? '…' : '';
  return highlight(prefix + content.slice(left, right) + suffix, {
    start: start - left + prefix.length, end: end - left + prefix.length,
  });
}

export function WorkspaceSearchResults({ index, query, filters, onChangeFilters, onOpen }: SearchResultsProps) {
  const [limit, setLimit] = useState(pageSize);
  const [stale, setStale] = useState(false);
  const results = useMemo(() => {
    const matches: SearchResult[] = [];
    for (const result of searchWorkspace(index, query, filters)) {
      matches.push(result);
      if (matches.length > limit) break;
    }
    return matches;
  }, [index, query, filters, limit]);

  function changeFilters(next: SearchFilters) {
    setLimit(pageSize);
    setStale(false);
    onChangeFilters(next);
  }

  return (
    <>
      <div className="space-y-1 px-1 pb-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-11">Tag</span>
          <Select className={filterClass} value={filters.tag} options={[{ value: '', label: 'All tags' }, ...[...index.tags].sort((a, b) => a[1].localeCompare(b[1])).map(([key, name]) => ({ value: key, label: name }))]}
            onValueChange={(tag) => changeFilters({ ...filters, tag })} />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-11">Folder</span>
          <Select className={filterClass} value={filters.folder} options={[{ value: '', label: 'All folders' }, ...[...index.folders].map(([id, folder]) => ({ value: id, label: folder.path }))]}
            onValueChange={(folder) => changeFilters({ ...filters, folder })} />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-11">Archive</span>
          <Select className={filterClass} value={filters.archive} options={[
            { value: 'active', label: 'Active notes' }, { value: 'archived', label: 'Archived notes' }, { value: 'all', label: 'Active and archived' },
          ]} onValueChange={(archive) => { if (archive === 'active' || archive === 'archived' || archive === 'all') changeFilters({ ...filters, archive }); }} />
        </label>
      </div>
      {stale && <p role="status" className="px-2 py-1 text-xs text-muted-foreground">That match changed. Choose a current result.</p>}
      {results.length === 0 && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">No matching notes.</p>}
      <ul className="space-y-0.5">
        {results.slice(0, limit).map((result) => {
          const { entry, range, titleMatch, matchingTag } = result;
          return (
            <li key={`${entry.note.id}:${range?.start ?? 'note'}`}>
              <button
                type="button"
                className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring"
                onClick={() => setStale(!onOpen(result))}
              >
                <span className="block truncate text-sm">{highlight(entry.note.name, titleMatch)}</span>
                {(entry.path || entry.archived) && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {[entry.path, entry.archived ? 'Archived' : ''].filter(Boolean).join(' · ')}
                  </span>
                )}
                {range && <span className="block text-xs break-words whitespace-pre-wrap text-muted-foreground">{snippet(entry.note.content ?? '', range)}</span>}
                {!range && matchingTag && <span className="block truncate text-xs text-muted-foreground">{matchingTag}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {results.length > limit && <Button size="xs" variant="ghost" onClick={() => setLimit(limit + pageSize)}>Show more matches</Button>}
    </>
  );
}
