import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { EditorView as ProseMirrorView } from 'prosemirror-view';
import type { EditorView } from './editor-header';
import { MathEditorPopover } from './math-editor-popover';
import type { MathEditorSession } from './math-visual';
import { SlashMenu, type SlashMenuState } from './slash-menu';
import { formatSource } from './source-formatting';
import { normalizeNewlines, originalSourceOffset, restoreSourceNewlines } from './source-newlines';
import { emptyFormatting, prepareSourceFormatting, sourceFormatting, visualFormatting } from './toolbar/formatting-state';
import { MarkdownToolbar, type MarkdownAction } from './toolbar/markdown-toolbar';
import { copyVisualMarkdown, createVisualState, formatVisual } from './visual-editor';
import { wikiInputContext, wikiSyntax } from '@/lib/wiki-markdown';
import { filterWikiNotes, matchWikiInput, textareaCaret, WikiSuggestionMenu, wikiListId, type WikiMenu, type WikiSuggestion } from './wiki-suggestions';
import type { WikiEditorActions } from './wiki-visual';
import { readVisualMarkdown, translatePosition, writeVisualMarkdown, type VisualMarkdown } from './visual-markdown';

export type MarkdownEditorHandle = {
  navigateToOffset: (offset: number) => void;
  rememberSelection: () => void;
};

type MarkdownEditorProps = {
  ref?: Ref<MarkdownEditorHandle>;
  value: string;
  view: EditorView;
  sourceLabel?: string;
  wiki: WikiEditorActions;
  onChange: (value: string) => void;
};

type SourceSelection = { start: number; end: number; backward?: boolean };
type VisualSession = { markdown: VisualMarkdown; state: EditorState; content: string };

function placeSourceSelection(source: HTMLTextAreaElement, selection: SourceSelection, markdown: string) {
  const normalizeOffset = (offset: number) => normalizeNewlines(markdown.slice(0, offset)).length;
  const start = normalizeOffset(selection.start);
  const end = normalizeOffset(selection.end);
  const probe = source.cloneNode(false) as HTMLTextAreaElement;
  probe.removeAttribute('aria-label');
  probe.inert = true;
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: `${source.clientWidth}px`, height: '0', overflow: 'hidden' });
  probe.value = source.value.slice(0, start);
  source.after(probe);
  const caretTop = probe.scrollHeight;
  probe.remove();

  source.focus({ preventScroll: true });
  source.setSelectionRange(start, end, selection.backward ? 'backward' : 'forward');
  source.scrollTop = caretTop - source.clientHeight / 2;
}

function placeVisualSelection(view: ProseMirrorView, markdown: VisualMarkdown, selection: SourceSelection) {
  const { doc } = view.state;
  const { blocks } = writeVisualMarkdown(markdown, doc);
  const from = translatePosition(blocks, selection.start, 'source');
  const to = translatePosition(blocks, selection.end, 'source');
  const anchor = doc.resolve(selection.backward ? to : from);
  const head = doc.resolve(selection.backward ? from : to);
  view.dispatch(view.state.tr.setSelection(TextSelection.between(anchor, head)).scrollIntoView());
  view.focus();
}

export function MarkdownEditor({ ref, value, view, sourceLabel, wiki, onChange }: MarkdownEditorProps) {
  const [visualFormats, setVisualFormats] = useState(emptyFormatting);
  const [sourceRange, setSourceRange] = useState({ start: 0, end: 0 });
  const sourceDocument = useMemo(
    () => view === 'source' && !sourceLabel ? prepareSourceFormatting(normalizeNewlines(value)) : null,
    [value, view, sourceLabel],
  );
  const formats = useMemo(() => view === 'document' ? visualFormats
    : sourceDocument ? sourceFormatting(sourceDocument, sourceRange.start, sourceRange.end) : emptyFormatting,
  [view, visualFormats, sourceDocument, sourceRange]);

  function recordSourceSelection(source: HTMLTextAreaElement) {
    const { selectionStart: start, selectionEnd: end } = source;
    setSourceRange((previous) => previous.start === start && previous.end === end ? previous : { start, end });
  }

  function recordVisualSelection(state: EditorState) {
    const next = visualFormatting(state);
    setVisualFormats((previous) => previous.heading === next.heading && previous.link === next.link
      && JSON.stringify(previous.toggles) === JSON.stringify(next.toggles) ? previous : next);
  }

  const [wikiMenu, setWikiMenu] = useState<WikiMenu | null>(null);
  const sourceMenu = useRef({ signature: '', dismissed: '', selected: 0 });
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const [mathEditor, setMathEditor] = useState<MathEditorSession | null>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const visualHostRef = useRef<HTMLDivElement>(null);
  const visualViewRef = useRef<ProseMirrorView>(null);
  const visualSessionRef = useRef<VisualSession>(null);
  const pendingSelectionRef = useRef<SourceSelection>(null);
  const documentRef = useRef({ value, onChange, wiki });

  useLayoutEffect(() => {
    documentRef.current = { value, onChange, wiki };
  }, [value, onChange, wiki]);

  useLayoutEffect(() => {
    setWikiMenu(null);
    setMathEditor(null);
    const selection = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    if (view === 'source') {
      if (selection && sourceRef.current) placeSourceSelection(sourceRef.current, selection, documentRef.current.value);
      return;
    }

    const host = visualHostRef.current;
    if (!host) return;
    const markdownContent = documentRef.current.value;
    let session = visualSessionRef.current;
    if (!session || session.content !== markdownContent) {
      const markdown = readVisualMarkdown(markdownContent);
      session = {
        markdown,
        state: createVisualState(markdown, setSlashMenu, () => documentRef.current.wiki, setWikiMenu, setMathEditor),
        content: markdownContent,
      };
      visualSessionRef.current = session;
    }
    const activeSession = session;

    const editor = new ProseMirrorView(host, {
      state: activeSession.state,
      attributes: {
        role: 'textbox',
        'aria-label': 'Visual Markdown editor',
        'aria-multiline': 'true',
        class: 'visual-markdown editor-text',
        spellcheck: 'false',
      },
      clipboardTextSerializer: (slice) => copyVisualMarkdown(slice.content),
      dispatchTransaction(transaction) {
        const { state: nextState, transactions } = editor.state.applyTransaction(transaction);
        editor.updateState(nextState);
        recordVisualSelection(nextState);
        activeSession.state = nextState;
        if (transactions.some((applied) => applied.docChanged)) {
          const { content } = writeVisualMarkdown(activeSession.markdown, nextState.doc);
          if (content !== activeSession.content) {
            activeSession.content = content;
            documentRef.current.onChange(content);
          }
        }
      },
    });
    visualViewRef.current = editor;
    recordVisualSelection(editor.state);
    if (selection) placeVisualSelection(editor, activeSession.markdown, selection);
    return () => {
      visualViewRef.current = null;
      editor.destroy();
    };
  }, [view]);

  useLayoutEffect(() => {
    const editor = visualViewRef.current;
    const session = visualSessionRef.current;
    if (!editor || !session || session.content === value) return;
    const markdown = readVisualMarkdown(value);
    const current = editor.state.doc.content;
    const next = markdown.document.content;
    const start = current.findDiffStart(next);
    session.markdown = markdown;
    session.content = value;
    if (start !== null) {
      const end = current.findDiffEnd(next)!;
      const overlap = start - Math.min(end.a, end.b);
      const transaction = editor.state.tr.replace(start, end.a + Math.max(0, overlap),
        markdown.document.slice(start, end.b + Math.max(0, overlap))).setMeta('addToHistory', false);
      session.state = editor.state.apply(transaction);
      editor.updateState(session.state);
      recordVisualSelection(session.state);
    }
  }, [value, view]);

  useLayoutEffect(() => {
    if (view === 'source' && sourceRef.current) recordSourceSelection(sourceRef.current);
  }, [view, value]);

  useLayoutEffect(() => {
    const source = sourceRef.current;
    if (view !== 'source' || !source) return;
    // Native selection events also cover programmatic cursor changes.
    const sync = () => recordSourceSelection(source);
    source.addEventListener('select', sync);
    return () => source.removeEventListener('select', sync);
  }, [view]);

  useImperativeHandle(ref, () => ({
    rememberSelection() {
      const editor = visualViewRef.current;
      const session = visualSessionRef.current;
      if (editor && session) {
        const { blocks } = writeVisualMarkdown(session.markdown, editor.state.doc);
        const { from, to, anchor, head } = editor.state.selection;
        pendingSelectionRef.current = {
          start: translatePosition(blocks, from, 'editor'),
          end: translatePosition(blocks, to, 'editor'),
          backward: anchor > head,
        };
      } else if (sourceRef.current) {
        const source = sourceRef.current;
        pendingSelectionRef.current = {
          start: originalSourceOffset(value, source.selectionStart),
          end: originalSourceOffset(value, source.selectionEnd),
          backward: source.selectionDirection === 'backward',
        };
      }
    },
    navigateToOffset(offset) {
      const selection = { start: offset, end: offset };
      const editor = visualViewRef.current;
      const session = visualSessionRef.current;
      if (editor && session) placeVisualSelection(editor, session.markdown, selection);
      else if (sourceRef.current) {
        placeSourceSelection(sourceRef.current, selection, value);
        recordSourceSelection(sourceRef.current);
      }
    },
  }), [value]);

  function focusEditor() {
    if (visualViewRef.current) visualViewRef.current.focus();
    else sourceRef.current?.focus({ preventScroll: true });
  }

  function changeSource(content: string) {
    onChange(restoreSourceNewlines(value, content));
  }

  function syncSourceWiki(source: HTMLTextAreaElement) {
    if (sourceLabel || source.selectionStart !== source.selectionEnd || document.activeElement !== source) {
      setWikiMenu(null);
      return;
    }
    const cursor = source.selectionStart;
    const line = source.value.lastIndexOf('\n', cursor - 1);
    const match = matchWikiInput(source.value.slice(line + 1, cursor), cursor, source.value.slice(cursor));
    const state = sourceMenu.current;
    const context = match && wikiInputContext(source.value, match.from);
    if (!match || !context) {
      state.dismissed = '';
      setWikiMenu(null);
      return;
    }
    const signature = `${match.from}:${match.query}:${match.alias ?? ''}`;
    if (state.dismissed === signature) return;
    if (state.signature !== signature) state.selected = 0;
    state.signature = signature;
    const results = filterWikiNotes(wiki.suggestions, match.query);
    state.selected = Math.min(state.selected, Math.max(0, results.length - 1));
    const caret = textareaCaret(source, cursor);
    setWikiMenu({
      results, selected: state.selected, left: caret.left, top: caret.top, bottom: caret.bottom,
      choose(note: WikiSuggestion) {
        const syntax = wikiSyntax(note.target, match.alias?.trim() || null, context.inTable);
        source.focus();
        source.setSelectionRange(match.from, match.to);
        if (!source.ownerDocument.execCommand('insertText', false, syntax)) {
          source.setRangeText(syntax, match.from, match.to, 'end');
          changeSource(source.value);
        }
        setWikiMenu(null);
      },
    });
  }

  function applyFormatting(action: MarkdownAction) {
    if (visualViewRef.current) formatVisual(visualViewRef.current, action);
    else if (sourceRef.current) {
      formatSource(sourceRef.current, action, changeSource);
      recordSourceSelection(sourceRef.current);
    }
  }

  return (
    <>
      {!sourceLabel && <MarkdownToolbar key={view} formats={formats} onAction={applyFormatting} onReturnFocus={focusEditor} />}
      <textarea
        ref={sourceRef}
        hidden={view !== 'source'}
        aria-label={sourceLabel ?? 'Markdown source'}
        className="min-h-0 w-full flex-1 resize-none bg-background bg-local editor-text focus-visible:outline-2 focus-visible:outline-ring/50"
        spellCheck={false}
        value={normalizeNewlines(value)}
        aria-controls={view === 'source' && wikiMenu ? wikiListId : undefined}
        aria-activedescendant={view === 'source' && wikiMenu?.results.length ? `${wikiListId}-${wikiMenu.selected}` : undefined}
        onChange={(event) => {
          changeSource(event.target.value);
          recordSourceSelection(event.currentTarget);
          syncSourceWiki(event.currentTarget);
        }}
        onSelect={(event) => {
          recordSourceSelection(event.currentTarget);
          syncSourceWiki(event.currentTarget);
        }}
        onScroll={(event) => { if (wikiMenu) syncSourceWiki(event.currentTarget); }}
        onBlur={() => { if (view === 'source') setWikiMenu(null); }}
        onKeyDown={(event) => {
          if (wikiMenu && !event.nativeEvent.isComposing) {
            const state = sourceMenu.current;
            if (event.key === 'Escape') {
              event.preventDefault();
              state.dismissed = state.signature;
              setWikiMenu(null);
              return;
            }
            const count = wikiMenu.results.length;
            if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              state.selected = (state.selected + count + (event.key === 'ArrowDown' ? 1 : -1)) % count;
              syncSourceWiki(event.currentTarget);
              return;
            }
            if (count && event.key === 'Enter') {
              event.preventDefault();
              wikiMenu.choose(wikiMenu.results[state.selected]);
              return;
            }
          }
          if (sourceLabel || !(event.metaKey || event.ctrlKey) || event.altKey) return;
          const key = event.key.toLowerCase();
          if (key !== 'b' && key !== 'i') return;
          event.preventDefault();
          applyFormatting({ type: key === 'b' ? 'bold' : 'italic' });
        }}
      />
      {view === 'document' && <div ref={visualHostRef} className="min-h-0 flex-1 overflow-auto bg-background bg-local" />}
      {wikiMenu && <WikiSuggestionMenu menu={wikiMenu} />}
      {view === 'document' && slashMenu && <SlashMenu menu={slashMenu} />}
      {view === 'document' && <MathEditorPopover session={mathEditor} />}
    </>
  );
}
