import { Fragment, Slice } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';
import { readVisualMarkdown, visualSchema } from './visual-markdown';

const { paragraph, yaml_frontmatter: frontmatter } = visualSchema.nodes;

export function pasteVisualMarkdown(view: EditorView, event: ClipboardEvent) {
  const { state } = view;
  if (state.selection.$from.parent.type.spec.code) return false;

  const text = event.clipboardData?.getData('text/plain');
  if (!text?.trim()) return false;
  const { document } = readVisualMarkdown(text);
  const metadata = document.firstChild?.type === frontmatter ? document.firstChild : null;
  // The HTML slice preserves internal selections, while the Markdown text carries frontmatter.
  if (!metadata && /\bdata-pm-slice=/.test(event.clipboardData?.getData('text/html') ?? '')) return false;
  const body = metadata ? document.content.cut(metadata.nodeSize) : document.content;
  const first = body.firstChild;
  const inline = body.childCount === 1 && first?.type === paragraph ? first : null;
  const hasFormatting = !inline || inline.content.content.some((node) => !node.isText || node.marks.length > 0);
  if (!metadata && !hasFormatting) return false;

  const transaction = state.tr;
  if (inline?.content.size) {
    const leadingSpace = text.match(/^[ \t]+/)?.[0];
    const trailingSpace = text.match(/[ \t]+$/)?.[0];
    let content = inline.content;
    if (leadingSpace) content = Fragment.from(visualSchema.text(leadingSpace)).append(content);
    if (trailingSpace) content = content.append(Fragment.from(visualSchema.text(trailingSpace)));
    transaction.replaceSelection(new Slice(content, 0, 0));
  } else if (!inline) {
    // Positions in the clipboard source do not refer to blocks in the destination note.
    const blocks = body.content.map((block) => block.type.create(
      { ...block.attrs, sourceIndex: null }, block.content, block.marks,
    ));
    transaction.replaceSelection(new Slice(Fragment.fromArray(blocks), 0, 0));
  }
  // Keep the destination metadata if the note already has a frontmatter block.
  if (metadata && transaction.doc.firstChild?.type !== frontmatter) {
    transaction.insert(0, metadata.type.create({ source: metadata.attrs.source }));
  }
  if (!transaction.docChanged) return false;
  view.dispatch(closeHistory(transaction).setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView());
  return true;
}
