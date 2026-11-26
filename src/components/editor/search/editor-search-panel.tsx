import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { normalizeNewlines } from '../source-newlines';
import { replaceSearchMatches, scrollToSearchMatch, setSearchHighlights, visualSearchRuns, type SearchEditor } from './editor-search';
import type { SearchOptions, SearchResult } from './search-matches';

type EditorReader = () => SearchEditor | null;
type SearchResponse = SearchResult & { document: object; options: SearchOptions };
const debounceMs = 120;
const searchBudgetMs = 500;
const inputClass = 'min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring';

function editorDocument(editor: SearchEditor) {
  return editor.view.state.doc;
}

export function useSearchShortcut(
  workspace: RefObject<HTMLDivElement | null>,
  open: boolean,
  show: (replace: boolean) => void,
  close: () => void,
) {
  useEffect(() => {
    function handle(event: KeyboardEvent) {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || !(target instanceof Element)) return;
      if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-attachment-controls]')) return;
      const insideEditor = workspace.current?.contains(target);
      if (open && insideEditor && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (!insideEditor && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !/^[fh]$/i.test(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) show(event.key.toLowerCase() === 'h');
    }
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [workspace, open, show, close]);
}

export function EditorSearchPanel({ readEditor, value, mode, replaceOpen, focusRequest, onClose }: {
  readEditor: EditorReader;
  value: string;
  mode: string;
  replaceOpen: boolean;
  focusRequest: number;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<SearchOptions>({ query: '', caseSensitive: false, wholeWord: false, regex: false });
  const [replacement, setReplacement] = useState('');
  const [response, setResponse] = useState<SearchResponse>();
  const [position, setPosition] = useState<number>();
  const [confirmation, setConfirmation] = useState<SearchResponse>();
  const input = useRef<HTMLTextAreaElement>(null);
  const revealOnResult = useRef(false);
  const displayedEditor = useRef<SearchEditor>(null);
  const editor = readEditor();
  const current = response && editor && response.document === editorDocument(editor) && response.options === options ? response : undefined;
  const matches = current?.matches;
  const anchor = position ?? (editor?.mode === 'source' ? editor.view.state.selection.main.from : editor?.view.state.selection.from) ?? 0;
  const nextIndex = matches?.findIndex((match) => match.to > anchor) ?? -1;
  const activeIndex = nextIndex < 0 ? 0 : nextIndex;
  const active = matches?.[activeIndex];
  const invalidReplacement = mode === 'document' && /[\r\n]/.test(replacement);

  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [focusRequest]);

  useEffect(() => {
    if (!options.query) return;
    let worker: Worker | undefined;
    let deadline: number | undefined;
    const debounce = window.setTimeout(() => {
      const editor = readEditor();
      if (!editor) return;
      const document = editorDocument(editor);
      const runs = editor.mode === 'source'
        ? [{ from: 0, text: editor.view.state.doc.toString() }]
        : visualSearchRuns(editor.view.state.doc);
      const finish = (result: SearchResult) => {
        window.clearTimeout(deadline);
        worker?.terminate();
        setResponse({ ...result, document, options });
      };
      try {
        worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<SearchResult>) => finish(data);
        worker.onerror = () => finish({ matches: [], error: 'Search could not run.' });
        deadline = window.setTimeout(() => finish({
          matches: [], error: 'Search took too long. Try a simpler pattern or a narrower search.',
        }), searchBudgetMs);
        worker.postMessage({ runs, options: { ...options, query: normalizeNewlines(options.query) } });
      } catch {
        finish({ matches: [], error: 'Search could not run.' });
      }
    }, debounceMs);
    return () => {
      window.clearTimeout(debounce);
      window.clearTimeout(deadline);
      worker?.terminate();
    };
  }, [mode, options, readEditor, value]);

  useLayoutEffect(() => {
    const activeEditor = readEditor();
    if (!activeEditor) return;
    displayedEditor.current = activeEditor;
    const fresh = current?.document === editorDocument(activeEditor);
    setSearchHighlights(activeEditor, fresh ? matches ?? [] : [], activeIndex);
    if (fresh && active && revealOnResult.current) {
      revealOnResult.current = false;
      scrollToSearchMatch(activeEditor, active);
    }
  }, [active, activeIndex, current, matches, mode, readEditor]);

  useLayoutEffect(() => () => {
    const previous = displayedEditor.current;
    // An editor may already have detached during a tab switch.
    if (previous?.view.dom.isConnected) setSearchHighlights(previous, [], -1);
  }, []);

  function updateOptions(change: Partial<SearchOptions>) {
    revealOnResult.current = true;
    setOptions((previous) => ({ ...previous, ...change }));
    setPosition(undefined);
    setConfirmation(undefined);
  }

  function navigate(direction: number) {
    if (!matches?.length || !current) return;
    const target = readEditor();
    if (!target || current.document !== editorDocument(target)) return;
    const index = (activeIndex + direction + matches.length) % matches.length;
    const match = matches[index];
    setPosition(match.from);
    setConfirmation(undefined);
    setSearchHighlights(target, matches, index);
    scrollToSearchMatch(target, match);
  }

  function replace(all: boolean) {
    const target = readEditor();
    if (!target || !current || !active || !matches || invalidReplacement || current.document !== editorDocument(target)) return;
    const insert = normalizeNewlines(replacement);
    const changed = replaceSearchMatches(target, all ? matches : [active], insert);
    setPosition(all ? undefined : active.from + insert.length);
    setConfirmation(undefined);
    // Identical replacements can leave the current document and search result intact.
    if (!all && !changed) navigate(1);
  }

  const confirming = Boolean(replaceOpen && confirmation && confirmation === current);
  const count = matches?.length ?? 0;
  const status = current?.error ?? (count ? `${activeIndex + 1} of ${count}` : current ? 'No matches' : options.query ? 'Searching…' : '');

  return (
    <section aria-label="Find and replace in note" className="z-10 mb-1 ml-auto grid w-full max-w-xl gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-sm">
      <div className="flex flex-wrap items-center gap-1">
        <textarea rows={1} ref={input} aria-label="Find in note" placeholder="Find in note" value={options.query} className={inputClass + ' resize-none'}
          aria-invalid={Boolean(current?.error)} title="Alt+Enter inserts a line break"
          onChange={(event) => updateOptions({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.altKey) {
              event.preventDefault();
              const { selectionStart, selectionEnd } = event.currentTarget;
              updateOptions({ query: options.query.slice(0, selectionStart) + '\n' + options.query.slice(selectionEnd) });
              requestAnimationFrame(() => input.current?.setSelectionRange(selectionStart + 1, selectionStart + 1));
            } else if (event.key === 'Enter' && !event.altKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              navigate(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <Button size="icon-sm" variant="ghost" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!count} onClick={() => navigate(-1)}><ChevronUp /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Next match" title="Next match (Enter)" disabled={!count} onClick={() => navigate(1)}><ChevronDown /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close find and replace" title="Close (Escape)" onClick={onClose}><X /></Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {([
          ['caseSensitive', 'Match case'], ['wholeWord', 'Whole word'], ['regex', 'Regex'],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1">
            <input type="checkbox" checked={options[key]} onChange={(event) => updateOptions({ [key]: event.target.checked })} />
            {label}
          </label>
        ))}
        <span role="status" className="ml-auto text-muted-foreground">{status}</span>
      </div>
      {replaceOpen && (
        <div className="flex flex-wrap items-center gap-1">
          <textarea rows={1} aria-label="Replace with" placeholder="Replace with" value={replacement} className={inputClass + ' resize-none'}
            onChange={(event) => { setReplacement(event.target.value); setConfirmation(undefined); }} />
          <Button size="sm" variant="ghost" disabled={!active || invalidReplacement} onClick={() => replace(false)}>Replace</Button>
          <Button size="sm" variant="outline" disabled={!active || invalidReplacement || confirming} onClick={() => setConfirmation(current)}>Replace all</Button>
        </div>
      )}
      {replaceOpen && invalidReplacement && <p role="status" className="text-xs">Use Source mode for multiline replacement.</p>}
      {confirming && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-auto">Replace {count} {count === 1 ? 'match' : 'matches'} in this note?</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirmation(undefined)}>Cancel</Button>
          <Button size="sm" variant="default" onClick={() => replace(true)}>Confirm replacement</Button>
        </div>
      )}
    </section>
  );
}
