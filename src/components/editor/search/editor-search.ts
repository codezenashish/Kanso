import { isolateHistory } from '@codemirror/commands';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration as SourceDecoration, EditorView as SourceView } from '@codemirror/view';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as VisualNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration as VisualDecoration, DecorationSet, type EditorView as VisualView } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';
import { revealSectionAt } from '../collapsible-sections';
import type { SearchMatch, SearchRun } from './search-matches';

type Highlights = { matches: SearchMatch[]; active: number };
const highlightClass = (active: boolean) => active ? 'editor-search-match editor-search-active' : 'editor-search-match';

const sourceHighlights = StateEffect.define<Highlights>();
export const sourceSearchExtension = StateField.define({
  create: () => SourceDecoration.none,
  update(decorations, transaction) {
    const effect = transaction.effects.find((effect) => effect.is(sourceHighlights));
    if (effect?.is(sourceHighlights)) {
      const { matches, active } = effect.value;
      return SourceDecoration.set(matches.map(({ from, to }, index) => SourceDecoration.mark({ class: highlightClass(index === active) }).range(from, to)));
    }
    return transaction.docChanged ? SourceDecoration.none : decorations;
  },
  provide: (field) => SourceView.decorations.from(field),
});

const visualHighlights = new PluginKey<DecorationSet>('editorSearch');
export const visualSearchExtension = Extension.create({
  name: 'editorSearch',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: visualHighlights,
      state: {
        init: () => DecorationSet.empty,
        apply(transaction, decorations: DecorationSet) {
          const highlights = transaction.getMeta(visualHighlights) as Highlights | undefined;
          if (!highlights) return transaction.docChanged ? DecorationSet.empty : decorations;
          return DecorationSet.create(transaction.doc, highlights.matches.map(({ from, to }, index) =>
            VisualDecoration.inline(from, to, { class: highlightClass(index === highlights.active) })));
        },
      },
      props: { decorations: (state) => visualHighlights.getState(state) },
    })];
  },
});

export function visualSearchRuns(doc: VisualNode) {
  const runs: SearchRun[] = [];
  doc.descendants((node, position) => {
    if (node.isAtom || node.type.name === 'preserved_markdown') return false;
    if (!node.isTextblock) return true;
    let run: SearchRun | undefined;
    node.forEach((child, offset) => {
      if (child.isText) {
        if (run) run.text += child.text!;
        else {
          run = { from: position + 1 + offset, text: child.text! };
          runs.push(run);
        }
      } else run = undefined;
    });
    return false;
  });
  return runs;
}

export type SearchEditor = { mode: 'source'; view: SourceView } | { mode: 'visual'; view: VisualView };

export function setSearchHighlights(editor: SearchEditor, matches: SearchMatch[], active: number) {
  const highlights = { matches, active };
  if (editor.mode === 'source') editor.view.dispatch({ effects: sourceHighlights.of(highlights) });
  else editor.view.dispatch(editor.view.state.tr.setMeta(visualHighlights, highlights));
}

export function scrollToSearchMatch(editor: SearchEditor, match: SearchMatch) {
  if (editor.mode === 'source') {
    editor.view.dispatch({ effects: SourceView.scrollIntoView(match.from, { y: 'nearest', yMargin: 24 }) });
  } else {
    const { view } = editor;
    revealSectionAt(view, match.from);
    const bounds = view.coordsAtPos(match.from);
    const pane = view.dom.parentElement;
    if (!pane) return;
    const viewport = pane.getBoundingClientRect();
    if (bounds.top < viewport.top + 16 || bounds.bottom > viewport.bottom - 16) {
      pane.scrollTop += bounds.top - viewport.top - pane.clientHeight / 3;
    }
    const table = view.domAtPos(match.from).node.parentElement?.closest('.editor-table-scroll');
    if (table) {
      const viewport = table.getBoundingClientRect();
      if (bounds.left < viewport.left || bounds.right > viewport.right) table.scrollLeft += bounds.left - viewport.left - 16;
    }
  }
}

export function replaceSearchMatches(editor: SearchEditor, matches: SearchMatch[], replacement: string) {
  if (editor.mode === 'source') {
    const changes = matches.filter(({ from, to }) => editor.view.state.sliceDoc(from, to) !== replacement).map(({ from, to }) => ({ from, to, insert: replacement }));
    if (!changes.length) return false;
    editor.view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input.replace' });
  } else {
    const { view } = editor;
    const transaction = closeHistory(view.state.tr);
    for (let index = matches.length - 1; index >= 0; index--) {
      const { from, to } = matches[index];
      if (view.state.doc.textBetween(from, to) === replacement) continue;
      const marks = view.state.doc.resolve(from).nodeAfter?.marks;
      if (replacement) transaction.replaceWith(from, to, view.state.schema.text(replacement, marks));
      else transaction.delete(from, to);
    }
    if (!transaction.docChanged) return false;
    view.dispatch(transaction);
    view.dispatch(closeHistory(view.state.tr));
  }
  return true;
}
