import { useImperativeHandle, useRef, type CSSProperties, type Ref } from 'react';
import { FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getNoteFormat, type WorkspaceNode } from '@/lib/workspace-tree';
import { updateSettings, useSettings } from '@/lib/settings';
import type { EditorLayout } from './editor-layout';
import type { EditorView } from './editor-header';
import type { WikiEditorActions } from './wiki-visual';
import { MarkdownEditor, type MarkdownEditorHandle } from './markdown-editor';

export type EditorWorkspaceHandle = {
  navigateToOffset: (offset: number, end?: number) => void;
  rememberSelection: () => void;
  focus: () => void;
};

type EditorWorkspaceProps = {
  ref?: Ref<EditorWorkspaceHandle>;
  note: WorkspaceNode | undefined;
  view: EditorView;
  wiki: WikiEditorActions;
  onChangeContent: (content: string) => void;
  onPrepareAttachment: () => Promise<boolean>;
  onCreateNote: () => void;
};

function changeEditorLayout(editorLayout: EditorLayout) {
  updateSettings({ editorLayout });
}

export function EditorWorkspace({ ref, note, view, wiki, onChangeContent, onPrepareAttachment, onCreateNote }: EditorWorkspaceProps) {
  const { editorLayout, editorFont, editorFontSize, editorLineHeight } = useSettings();
  const typography = {
    '--editor-font-size': `${editorFontSize / 16}rem`,
    '--editor-line-height': editorLineHeight ?? undefined,
  } as CSSProperties;
  const editorRef = useRef<MarkdownEditorHandle>(null);
  useImperativeHandle(ref, () => ({
    navigateToOffset: (offset, end) => editorRef.current?.navigateToOffset(offset, end),
    rememberSelection: () => editorRef.current?.rememberSelection(),
    focus: () => editorRef.current?.focus(),
  }), []);

  if (!note) {
    return (
      <div className="m-auto px-4 text-center text-muted-foreground">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl border bg-card">
          <FileText className="size-6" />
        </div>
        <h2 className="heading">A little room to think.</h2>
        <p className="body-text mt-1 mb-4">Choose a note from your workspace, or create one to begin.</p>
        <Button variant="outline" size="default" onClick={onCreateNote}><Plus /> Create a note</Button>
      </div>
    );
  }

  const format = getNoteFormat(note.name);

  return (
    <section id="editor-workspace" aria-label="Editor" data-editor-font={editorFont} style={typography} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pb-5 md:px-6">
      <MarkdownEditor
        key={`${note.id}:${format}`}
        ref={editorRef}
        noteId={note.id}
        onPrepareAttachment={onPrepareAttachment}
        value={note.content ?? ''}
        view={view}
        layout={editorLayout}
        onChangeLayout={changeEditorLayout}
        wiki={wiki}
        sourceLabel={format === 'text' ? 'Plain text' : format === 'yaml' ? 'YAML source' : undefined}
        onChange={onChangeContent}
      />
    </section>
  );
}
