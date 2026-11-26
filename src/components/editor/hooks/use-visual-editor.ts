import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { setSearchHighlights } from '../search/editor-search';
import { createVisualEditor } from '../visual-editor';
import { readVisualMarkdown, translatePosition, writeVisualMarkdown, type VisualMarkdown } from '../visual-markdown';
import { emptyFormatting, sameFormatting, visualFormatting } from '../toolbar/formatting-state';

export type SourceSelection = { start: number; end: number; backward?: boolean };

type VisualSession = {
  markdown: VisualMarkdown;
  editor: Editor;
  content: string;
  serialization?: ReturnType<typeof writeVisualMarkdown>;
};

type VisualEditorOptions = Omit<Parameters<typeof createVisualEditor>[1], 'onUpdate' | 'onTransaction' | 'wikiActions'> & {
  active: boolean;
  host: RefObject<HTMLDivElement | null>;
  value: string;
  wiki: ReturnType<Parameters<typeof createVisualEditor>[1]['wikiActions']>;
  onChange: (content: string) => void;
};

function selectionMap(session: VisualSession) {
  return session.serialization ??= writeVisualMarkdown(session.markdown, session.editor.state.doc);
}

export function useVisualEditor(options: VisualEditorOptions) {
  const [formats, setFormats] = useState(emptyFormatting);
  const latest = useRef(options);
  const editor = useRef<Editor>(null);
  const session = useRef<VisualSession>(null);

  useLayoutEffect(() => { latest.current = options; });
  useLayoutEffect(() => () => {
    session.current?.editor.destroy();
    session.current = null;
  }, []);

  useLayoutEffect(() => {
    const host = options.host.current;
    if (!options.active || !host) return;

    let current = session.current;
    if (!current) {
      const configuration = latest.current;
      const instance = createVisualEditor(configuration.value, {
        noteId: configuration.noteId,
        mapAttachmentPosition: (mapping) => latest.current.mapAttachmentPosition?.(mapping),
        publishSlashMenu: configuration.publishSlashMenu,
        wikiActions: () => latest.current.wiki,
        publishWikiMenu: configuration.publishWikiMenu,
        publishWikiPreview: configuration.publishWikiPreview,
        publishMathEditor: configuration.publishMathEditor,
        publishFloatingToolbar: configuration.publishFloatingToolbar,
        onTransaction(updatedEditor) {
          const next = visualFormatting(updatedEditor.state);
          setFormats((previous) => sameFormatting(previous, next) ? previous : next);
        },
        onUpdate(updatedEditor, isExternalSync) {
          const activeSession = session.current;
          if (!activeSession || activeSession.editor !== updatedEditor || isExternalSync) return;
          const serialization = writeVisualMarkdown(activeSession.markdown, updatedEditor.state.doc);
          activeSession.serialization = serialization;
          if (serialization.content !== activeSession.content) {
            activeSession.content = serialization.content;
            latest.current.onChange(serialization.content);
          }
        },
      });
      current = { ...instance, content: configuration.value };
      session.current = current;
    }

    const instance = current.editor;
    instance.mount(host);
    editor.current = instance;
    setFormats(visualFormatting(instance.state));
    return () => {
      editor.current = null;
      if (!instance.isDestroyed) {
        setSearchHighlights({ mode: 'visual', view: instance.view }, [], -1);
        instance.unmount();
      }
    };
  }, [options.active, options.host]);

  useLayoutEffect(() => {
    const instance = editor.current;
    const current = session.current;
    if (!instance || !current || current.content === options.value) return;
    const markdown = readVisualMarkdown(options.value, instance.schema);
    const previous = instance.state.doc.content;
    const next = markdown.document.content;
    const start = previous.findDiffStart(next);
    const end = start !== null ? previous.findDiffEnd(next) : null;
    current.markdown = markdown;
    current.content = options.value;
    current.serialization = undefined;
    if (start !== null && end) {
      const overlap = Math.max(0, start - Math.min(end.a, end.b));
      instance.view.dispatch(instance.state.tr
        .replace(start, end.a + overlap, markdown.document.slice(start, end.b + overlap))
        .setMeta('addToHistory', false)
        .setMeta('kansoExternalSync', true));
    }
  }, [options.active, options.value]);

  useLayoutEffect(() => {
    const instance = editor.current;
    if (!options.active || !instance) return;
    instance.view.dispatch(instance.state.tr.setMeta('wikiDecorationsRefresh', true));
  }, [options.active, options.wiki]);

  return {
    editor,
    formats,
    readSelection(): SourceSelection | null {
      if (!session.current || !editor.current) return null;
      const { blocks } = selectionMap(session.current);
      const { from, to, anchor, head } = editor.current.state.selection;
      return {
        start: translatePosition(blocks, from, 'editor'),
        end: translatePosition(blocks, to, 'editor'),
        backward: anchor > head,
      };
    },
    placeSelection(selection: SourceSelection) {
      if (!session.current || !editor.current) return;
      const { blocks } = selectionMap(session.current);
      const view = editor.current.view;
      const { doc } = view.state;
      const from = translatePosition(blocks, selection.start, 'source');
      const to = translatePosition(blocks, selection.end, 'source');
      const anchor = doc.resolve(selection.backward ? to : from);
      const head = doc.resolve(selection.backward ? from : to);
      view.dispatch(view.state.tr.setSelection(TextSelection.between(anchor, head)).scrollIntoView());
      view.focus();
    },
  };
}
