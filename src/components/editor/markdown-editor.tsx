import { useCallback, useDeferredValue, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { EditorSelection } from '@codemirror/state';
import { EditorView as SourceEditorView } from '@codemirror/view';
import { useAttachmentInsertion } from './attachments/use-attachment-insertion';
import { DocumentScrollNavigator } from './document-scroll-navigator';
import type { EditorLayout } from './editor-layout';
import type { EditorView } from './editor-header';
import { FloatingToolbar, type FloatingToolbarState } from './floating-toolbar';
import { MathEditorPopover } from './math-editor-popover';
import type { MathEditorSession } from './math-visual';
import { SlashMenu, type SlashMenuState } from './slash-menu';
import { formatSource } from './source/source-formatting';
import { normalizeNewlines, originalSourceOffset } from './source-newlines';
import { EditorSearchPanel, useSearchShortcut } from './search/editor-search-panel';
import type { SearchEditor } from './search/editor-search';
import { useSourceEditor } from './hooks/use-source-editor';
import { useVisualEditor, type SourceSelection } from './hooks/use-visual-editor';
import { emptyFormatting, prepareSourceFormatting, sourceFormatting } from './toolbar/formatting-state';
import { MarkdownToolbar, type MarkdownAction } from './toolbar/markdown-toolbar';
import { formatVisual } from './visual-editor';
import { WikiLinkPreview, type WikiPreviewTrigger } from './wiki-link-preview';
import { WikiSuggestionMenu, type WikiMenu } from './wiki-suggestions';
import type { WikiEditorActions } from './wiki-visual';

export type MarkdownEditorHandle = {
  navigateToOffset: (offset: number, end?: number) => void;
  rememberSelection: () => void;
  focus: () => void;
};

type MarkdownEditorProps = {
  ref?: Ref<MarkdownEditorHandle>;
  noteId: string;
  onPrepareAttachment: () => Promise<boolean>;
  value: string;
  view: EditorView;
  layout: EditorLayout;
  onChangeLayout: (layout: EditorLayout) => void;
  sourceLabel?: string;
  wiki: WikiEditorActions;
  onChange: (value: string) => void;
};

const clipboardExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function clipboardImage(file: File) {
  const extension = clipboardExtensions[file.type];
  return extension && !/\.(?:png|jpe?g|gif|webp)$/i.test(file.name)
    ? new File([file], `Clipboard image.${extension}`, { type: file.type })
    : file;
}

function placeSourceSelection(source: SourceEditorView, selection: SourceSelection, markdown: string) {
  const start = normalizeNewlines(markdown.slice(0, selection.start)).length;
  const end = normalizeNewlines(markdown.slice(0, selection.end)).length;
  const range = EditorSelection.range(selection.backward ? end : start, selection.backward ? start : end);
  source.focus();
  source.dispatch({ selection: range, effects: SourceEditorView.scrollIntoView(range, { y: 'center' }) });
}

export function MarkdownEditor({ ref, noteId, onPrepareAttachment, value, view, layout, onChangeLayout, sourceLabel, wiki, onChange }: MarkdownEditorProps) {
  const [sourceRange, setSourceRange] = useState({ start: 0, end: 0 });
  const sourceSnapshot = useMemo(() => ({ value, range: sourceRange }), [value, sourceRange]);
  const { value: deferredSource, range: deferredRange } = useDeferredValue(sourceSnapshot);
  const sourceDocument = useMemo(
    () => view === 'source' && !sourceLabel ? prepareSourceFormatting(normalizeNewlines(deferredSource)) : null,
    [view, sourceLabel, deferredSource],
  );
  const [wikiMenu, setWikiMenu] = useState<WikiMenu | null>(null);
  const [wikiPreview, setWikiPreview] = useState<WikiPreviewTrigger | null>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const [mathEditor, setMathEditor] = useState<MathEditorSession | null>(null);
  const [floatingToolbar, setFloatingToolbar] = useState<FloatingToolbarState | null>(null);
  const workspaceHost = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState<{ open: boolean; replace: boolean; focusRequest: number }>({
    open: false, replace: false, focusRequest: 0,
  });
  const searchReturnFocus = useRef<HTMLElement>(null);
  const sourceHost = useRef<HTMLDivElement>(null);
  const visualHost = useRef<HTMLDivElement>(null);
  const paneScrollPositions = useRef<Partial<Record<EditorView, number>>>({});
  const pendingSelection = useRef<SourceSelection>(null);
  const sourceEditor = useSourceEditor({
    active: view === 'source',
    value, label: sourceLabel, host: sourceHost, wiki, onChange,
    onSelection(start, end) {
      setSourceRange((previous) => previous.start === start && previous.end === end ? previous : { start, end });
    },
    publishWiki: setWikiMenu,
    publishWikiPreview: setWikiPreview,
    mapAttachmentPosition: (changes) => attachments.mapPosition('source', (position) => changes.mapPos(position, 1)),
  });
  const visual = useVisualEditor({
    active: view === 'document',
    noteId,
    mapAttachmentPosition: (mapping) => attachments.mapPosition('document', (position) => mapping.map(position, 1)),
    host: visualHost,
    value, wiki, onChange,
    publishWikiMenu: setWikiMenu,
    publishWikiPreview: setWikiPreview,
    publishSlashMenu: setSlashMenu,
    publishMathEditor: setMathEditor,
    publishFloatingToolbar: setFloatingToolbar,
  });
  const attachments = useAttachmentInsertion(noteId, onPrepareAttachment, () => {
    if (sourceLabel) return null;
    if (view === 'source' && sourceEditor.current) return { mode: 'source', editor: sourceEditor.current };
    if (view === 'document' && visual.editor.current) return { mode: 'document', editor: visual.editor.current.view };
    return null;
  });
  const formats = useMemo(() => view === 'document' ? visual.formats
    : sourceDocument ? sourceFormatting(sourceDocument, deferredRange.start, deferredRange.end) : emptyFormatting,
  [view, visual.formats, sourceDocument, deferredRange]);

  useLayoutEffect(() => {
    setWikiMenu(null);
    setWikiPreview(null);
    setSlashMenu(null);
    setMathEditor(null);
    setFloatingToolbar(null);
    const selection = pendingSelection.current;
    pendingSelection.current = null;
    if (!selection) return;
    if (visual.editor.current) visual.placeSelection(selection);
    else if (sourceEditor.current) placeSourceSelection(sourceEditor.current, selection, value);
    const pane = view === 'document' ? visualHost.current : sourceEditor.current?.scrollDOM;
    const previousScroll = paneScrollPositions.current[view];
    if (pane && previousScroll !== undefined) {
      const restore = requestAnimationFrame(() => { pane.scrollTop = previousScroll; });
      return () => cancelAnimationFrame(restore);
    }
  }, [view]);

  const visualEditor = visual.editor;
  const focusEditor = useCallback(() => {
    if (visualEditor.current) visualEditor.current.view.focus();
    else sourceEditor.current?.focus();
  }, [sourceEditor, visualEditor]);


  const readSearchEditor = useCallback((): SearchEditor | null => {
    if (visualEditor.current) return { mode: 'visual', view: visualEditor.current.view };
    return sourceEditor.current ? { mode: 'source', view: sourceEditor.current } : null;
  }, [sourceEditor, visualEditor]);

  const showSearch = useCallback((replace: boolean) => {
    if (!search.open) searchReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSearch((previous) => ({ open: true, replace, focusRequest: previous.focusRequest + 1 }));
  }, [search.open]);

  const closeSearch = useCallback(() => {
    setSearch((previous) => ({ ...previous, open: false }));
    const previous = searchReturnFocus.current;
    if (previous?.isConnected && previous !== document.body && previous.getClientRects().length) {
      previous.focus({ preventScroll: true });
    } else focusEditor();
  }, [focusEditor]);

  useSearchShortcut(workspaceHost, search.open, showSearch, closeSearch);

  useImperativeHandle(ref, () => ({
    focus: focusEditor,
    rememberSelection() {
      if (visual.editor.current) {
        paneScrollPositions.current.document = visualHost.current?.scrollTop;
        pendingSelection.current = visual.readSelection();
      } else if (sourceEditor.current) {
        paneScrollPositions.current.source = sourceEditor.current.scrollDOM.scrollTop;
        const { from, to, anchor, head } = sourceEditor.current.state.selection.main;
        pendingSelection.current = {
          start: originalSourceOffset(value, from),
          end: originalSourceOffset(value, to),
          backward: anchor > head,
        };
      }
    },
    navigateToOffset(offset, end = offset) {
      const selection = { start: offset, end };
      if (visual.editor.current) visual.placeSelection(selection);
      else if (sourceEditor.current) placeSourceSelection(sourceEditor.current, selection, value);
    },
  }));

  const applyFormatting = useCallback((action: MarkdownAction) => {
    if (visualEditor.current) formatVisual(visualEditor.current, action);
    else if (sourceEditor.current) formatSource(sourceEditor.current, action);
  }, [sourceEditor, visualEditor]);

  return (
    <div ref={workspaceHost} className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOverCapture={(event) => {
        if (sourceLabel || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDropCapture={(event) => {
        if (sourceLabel || !event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        void attachments.run(Array.from(event.dataTransfer.files), { x: event.clientX, y: event.clientY });
      }}
      onPasteCapture={(event) => {
        if (sourceLabel || !event.clipboardData.files.length
            || event.clipboardData.getData('text/html') || event.clipboardData.getData('text/plain')
            || !(event.target instanceof Element) || !event.target.closest('.cm-content, .visual-markdown')
            || event.target.closest('[data-attachment-controls]')) return;
        const images = Array.from(event.clipboardData.files)
          .filter((file) => file.type.startsWith('image/')).map(clipboardImage);
        if (!images.length) return;
        event.preventDefault();
        event.stopPropagation();
        void attachments.run(images);
      }}
    >
      {!sourceLabel && (
        <MarkdownToolbar
          key={view}
          formats={formats}
          layout={layout}
          onChangeLayout={onChangeLayout}
          onAction={applyFormatting}
          onReturnFocus={focusEditor}
          onAttachFile={attachments.run}
          attachingFile={attachments.busy}
        />
      )}
      {search.open && <EditorSearchPanel
        readEditor={readSearchEditor}
        value={value}
        mode={view}
        replaceOpen={search.replace}
        focusRequest={search.focusRequest}
        onClose={closeSearch}
      />}
      <div role="status" className={attachments.message ? 'absolute inset-x-2 bottom-2 z-10 mx-auto w-fit max-w-[calc(100%-1rem)] rounded-md border border-border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-sm' : 'sr-only'}>
        {attachments.message}
      </div>
      <div
        ref={sourceHost}
        hidden={view !== 'source'}
        data-editor-layout={sourceLabel ? undefined : layout}
        className="source-editor-frame min-h-0 w-full flex-1 bg-background"
      />
      {view === 'document' && (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={visualHost}
            data-editor-layout={layout}
            className="min-h-0 flex-1 overflow-auto bg-background bg-local [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          />
          <DocumentScrollNavigator scrollHost={visualHost} />
        </div>
      )}
      {wikiMenu && <WikiSuggestionMenu menu={wikiMenu} />}
      {!sourceLabel && (
        <WikiLinkPreview
          trigger={wikiPreview}
          suppressed={Boolean(search.open || wikiMenu || slashMenu || mathEditor)}
          resolvePreview={wiki.preview}
        />
      )}
      {view === 'document' && slashMenu && <SlashMenu menu={slashMenu} />}
      {view === 'document' && !search.open && !slashMenu && !wikiMenu && !mathEditor && (
        <FloatingToolbar
          state={floatingToolbar}
          formats={formats}
          onAction={applyFormatting}
          onReturnFocus={focusEditor}
        />
      )}
      {view === 'document' && <MathEditorPopover session={mathEditor} />}
    </div>
  );
}
