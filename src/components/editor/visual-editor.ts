import { Editor } from '@tiptap/core';
import type { Mapping } from '@tiptap/pm/transform';
import type { Fragment, Schema } from '@tiptap/pm/model';
import { editorCommand, selectionTouchesSourceBlock } from './commands/visual-commands';
import type { FloatingToolbarState } from './floating-toolbar';
import type { MathEditorSession } from './math-visual';
import type { SlashMenuState } from './slash-menu';
import { createVisualExtensions, visualSchema } from './extensions/visual-extensions';
import type { MarkdownAction } from './toolbar/markdown-toolbar';
import { readVisualMarkdown, serializeVisualDocument, type VisualMarkdown } from './visual-markdown';
import type { WikiPreviewTrigger } from './wiki-link-preview';
import type { WikiMenu } from './wiki-suggestions';
import type { WikiEditorActions } from './wiki-visual';

export function createVisualEditor(
  source: string,
  callbacks: {
    noteId: string;
    mapAttachmentPosition?: (mapping: Mapping) => void;
    publishSlashMenu: (menu: SlashMenuState | null) => void;
    wikiActions: () => WikiEditorActions;
    publishWikiMenu: (menu: WikiMenu | null) => void;
    publishWikiPreview?: (trigger: WikiPreviewTrigger | null) => void;
    publishMathEditor: (session: MathEditorSession | null) => void;
    publishFloatingToolbar?: (toolbar: FloatingToolbarState | null) => void;
    onUpdate?: (editor: Editor, isExternalSync: boolean) => void;
    onTransaction?: (editor: Editor) => void;
  },
): { editor: Editor; markdown: VisualMarkdown } {
  let markdown!: VisualMarkdown;
  const editor = new Editor({
    element: null,
    extensions: createVisualExtensions({
      noteId: callbacks.noteId,
      onSlashMenuChange: callbacks.publishSlashMenu,
      runSlashAction: editorCommand,
      getWikiActions: callbacks.wikiActions,
      onWikiMenuChange: callbacks.publishWikiMenu,
      onWikiPreviewChange: callbacks.publishWikiPreview ?? (() => {}),
      onMathEditorChange: callbacks.publishMathEditor,
      onFloatingToolbarChange: callbacks.publishFloatingToolbar ?? (() => {}),
    }),
    onBeforeCreate({ editor: instance }) {
      markdown = readVisualMarkdown(source, instance.schema);
      instance.options.content = markdown.document.toJSON();
    },
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': 'Visual Markdown editor',
        'aria-multiline': 'true',
        class: 'visual-markdown editor-text',
        spellcheck: 'false',
      },
      clipboardTextSerializer: (slice, view) => copyVisualMarkdown(slice.content, view.state.schema),
    },
    onTransaction({ editor: updated, transaction, appendedTransactions }) {
      for (const change of [transaction, ...appendedTransactions]) {
        if (change.docChanged) callbacks.mapAttachmentPosition?.(change.mapping);
      }
      if ([transaction, ...appendedTransactions].some((change) => change.docChanged || change.selectionSet || change.storedMarksSet)) {
        callbacks.onTransaction?.(updated);
      }
    },
    onUpdate: ({ editor: updated, transaction }) => {
      callbacks.onUpdate?.(updated, Boolean(transaction.getMeta('kansoExternalSync')));
    },
  });
  return { editor, markdown };
}

export function formatVisual(editor: Editor, action: MarkdownAction) {
  if (action.type !== 'inlineMath' && action.type !== 'mathBlock' && action.type !== 'mermaid') {
    editor.view.focus();
  }
  if (action.type !== 'undo' && action.type !== 'redo' && selectionTouchesSourceBlock(editor.state)) return;
  editorCommand(action)(editor.state, editor.view.dispatch, editor.view);
}

export function copyVisualMarkdown(content: Fragment, schema: Schema = visualSchema) {
  return serializeVisualDocument(schema.nodes.doc.create(null, content));
}
