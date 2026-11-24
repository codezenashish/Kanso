import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { EditorView as ProseMirrorView } from 'prosemirror-view';
import 'prosemirror-view/style/prosemirror.css';
import type { EditorView } from './editor-header';
import { SlashMenu, type SlashMenuState } from './slash-menu';
import { formatSource } from './source-formatting';
import { normalizeNewlines, originalSourceOffset, restoreSourceNewlines } from './source-newlines';
import { MarkdownToolbar, type MarkdownAction } from './toolbar/markdown-toolbar';
import { copyVisualMarkdown, createVisualState, formatVisual } from './visual-editor';
import { readVisualMarkdown, translatePosition, writeVisualMarkdown, type VisualMarkdown } from './visual-markdown';

export type MarkdownEditorHandle = {
  navigateToHeading: (offset: number) => void;
  rememberSelection: () => void;
};

type MarkdownEditorProps = {
  ref?: Ref<MarkdownEditorHandle>;
  value: string;
  view: EditorView;
  isYaml: boolean;
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

const visualEditorClass = [
  'min-h-full wrap-anywhere text-base leading-[1.75] text-foreground outline-none',
  '[&_h1]:font-heading [&_h1]:text-3xl [&_h2]:text-2xl [&_h3]:text-xl [&_h4]:text-lg',
  '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold',
  '[&>*+*]:mt-3 [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ol]:list-decimal',
  '[&_blockquote]:rounded-e-md [&_blockquote]:border-s-2 [&_blockquote]:border-primary/45 [&_blockquote]:bg-muted/35 [&_blockquote]:px-4 [&_blockquote]:py-2 [&_blockquote>*+*]:mt-2',
  '[&_pre]:font-mono [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4',
  '[&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_th]:bg-muted/65 [&_th]:text-start [&_th]:font-medium',
  '[&_:is(td,th)]:relative [&_:is(td,th)]:border [&_:is(td,th)]:border-border [&_:is(td,th)]:px-3 [&_:is(td,th)]:py-1.5 [&_:is(td,th)]:align-top',
  '[&_.selectedCell]:bg-accent [&_.selectedCell]:outline [&_.selectedCell]:-outline-offset-1 [&_.selectedCell]:outline-ring/40',
  '[&_hr]:border-border',
  '[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_pre_code]:p-0',
].join(' ');

export function MarkdownEditor({ ref, value, view, isYaml, onChange }: MarkdownEditorProps) {
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const visualHostRef = useRef<HTMLDivElement>(null);
  const visualViewRef = useRef<ProseMirrorView>(null);
  const visualSessionRef = useRef<VisualSession>(null);
  const pendingSelectionRef = useRef<SourceSelection>(null);
  const documentRef = useRef({ value, onChange });

  useLayoutEffect(() => {
    documentRef.current = { value, onChange };
  }, [value, onChange]);

  useLayoutEffect(() => {
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
      session = { markdown, state: createVisualState(markdown, setSlashMenu), content: markdownContent };
      visualSessionRef.current = session;
    }
    const activeSession = session;

    const editor = new ProseMirrorView(host, {
      state: activeSession.state,
      attributes: {
        role: 'textbox',
        'aria-label': 'Visual Markdown editor',
        'aria-multiline': 'true',
        class: visualEditorClass,
        spellcheck: 'false',
      },
      clipboardTextSerializer: (slice) => copyVisualMarkdown(slice.content),
      dispatchTransaction(transaction) {
        const { state: nextState, transactions } = editor.state.applyTransaction(transaction);
        editor.updateState(nextState);
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
    if (selection) placeVisualSelection(editor, activeSession.markdown, selection);
    return () => {
      visualViewRef.current = null;
      editor.destroy();
    };
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
    navigateToHeading(offset) {
      const selection = { start: offset, end: offset };
      const editor = visualViewRef.current;
      const session = visualSessionRef.current;
      if (editor && session) placeVisualSelection(editor, session.markdown, selection);
      else if (sourceRef.current) placeSourceSelection(sourceRef.current, selection, value);
    },
  }), [value]);

  function focusEditor() {
    if (visualViewRef.current) visualViewRef.current.focus();
    else sourceRef.current?.focus({ preventScroll: true });
  }

  function changeSource(content: string) {
    onChange(restoreSourceNewlines(value, content));
  }

  function applyFormatting(action: MarkdownAction) {
    if (visualViewRef.current) formatVisual(visualViewRef.current, action);
    else if (sourceRef.current) formatSource(sourceRef.current, action, changeSource);
  }

  return (
    <>
      {!isYaml && <MarkdownToolbar key={view} onAction={applyFormatting} onReturnFocus={focusEditor} />}
      <textarea
        ref={sourceRef}
        hidden={view !== 'source'}
        aria-label={isYaml ? 'YAML source' : 'Markdown source'}
        className="min-h-0 w-full flex-1 resize-none bg-background font-sans text-base leading-[1.75] text-foreground focus-visible:outline-2 focus-visible:outline-ring/50"
        spellCheck={false}
        value={normalizeNewlines(value)}
        onChange={(event) => changeSource(event.target.value)}
        onKeyDown={(event) => {
          if (isYaml || !(event.metaKey || event.ctrlKey) || event.altKey) return;
          const key = event.key.toLowerCase();
          if (key !== 'b' && key !== 'i') return;
          event.preventDefault();
          applyFormatting({ type: key === 'b' ? 'bold' : 'italic' });
        }}
      />
      {view === 'document' && <div ref={visualHostRef} className="min-h-0 flex-1 overflow-auto" />}
      {view === 'document' && slashMenu && <SlashMenu menu={slashMenu} />}
    </>
  );
}
