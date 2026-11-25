import { useImperativeHandle, useRef, type Ref } from 'react';
import { FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WorkspaceNode } from '@/lib/workspace-tree';
import type { EditorView } from './editor-header';
import type { WikiEditorActions } from './wiki-visual';
import { MarkdownEditor, type MarkdownEditorHandle } from './markdown-editor';

export type EditorWorkspaceHandle = {
  navigateToOffset: (offset: number) => void;
  rememberSelection: () => void;
};

type EditorWorkspaceProps = {
  ref?: Ref<EditorWorkspaceHandle>;
  note: WorkspaceNode | undefined;
  view: EditorView;
  wiki: WikiEditorActions;
  onChangeContent: (content: string) => void;
  onCreateNote: () => void;
};

export function EditorWorkspace({ ref, note, view, wiki, onChangeContent, onCreateNote }: EditorWorkspaceProps) {
  const editorRef = useRef<MarkdownEditorHandle>(null);
  useImperativeHandle(ref, () => ({
    navigateToOffset: (offset) => editorRef.current?.navigateToOffset(offset),
    rememberSelection: () => editorRef.current?.rememberSelection(),
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

  return (
    <section id="editor-workspace" aria-label="Editor" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pb-5 md:px-6">
      <MarkdownEditor
        key={note.id}
        ref={editorRef}
        value={note.content ?? ''}
        view={view}
        wiki={wiki}
        sourceLabel={/\.txt$/i.test(note.name) ? 'Plain text' : /\.ya?ml$/i.test(note.name) ? 'YAML source' : undefined}
        onChange={onChangeContent}
      />
    </section>
  );
}
