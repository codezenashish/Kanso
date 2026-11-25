import { closeHistory } from 'prosemirror-history';
import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { scanWikiLinks } from '@/lib/wiki-markdown';
import { filterWikiNotes, matchWikiInput, wikiListId, type WikiMenu, type WikiSuggestion } from './wiki-suggestions';

export type WikiEditorActions = {
  suggestions: WikiSuggestion[];
  follow: (target: string) => void;
};

export function wikiVisualPlugin(actions: () => WikiEditorActions, publish: (menu: WikiMenu | null) => void) {
  let selected = 0;
  let menu: WikiMenu | null = null;
  let previous = '';
  let dismissed = '';

  function sync(view: EditorView, active = view.hasFocus()) {
    const { selection, schema, storedMarks } = view.state;
    const { $from } = selection;
    const marks = storedMarks ?? $from.marks();
    const literal = $from.parent.type.spec.code || marks.some((mark) => mark.type === schema.marks.code || mark.type === schema.marks.link);
    const match = active && selection.empty && !view.composing && !literal ? matchWikiInput(
      $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc'), $from.pos,
      $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '\n', '\ufffc'),
    ) : null;
    const signature = match ? `${match.from}:${match.query}:${match.alias ?? ''}` : '';
    if (!match || signature === dismissed) {
      if (!match) dismissed = '';
      if (menu) {
        menu = null;
        if (view.dom.getAttribute('aria-controls') === wikiListId) {
          view.dom.removeAttribute('aria-controls');
          view.dom.removeAttribute('aria-activedescendant');
        }
        publish(null);
      }
      return;
    }
    if (signature !== previous) selected = 0;
    previous = signature;
    const results = filterWikiNotes(actions().suggestions, match.query);
    selected = Math.min(selected, Math.max(0, results.length - 1));
    const caret = view.coordsAtPos(selection.from);
    menu = {
      results, selected, left: caret.left, top: caret.top, bottom: caret.bottom,
      choose(note) {
        const { from, to, alias } = match;
        const link = schema.nodes.wiki_link.create({ target: note.target, alias: alias?.trim() || null }, null, marks);
        const transaction = closeHistory(view.state.tr.replaceWith(from, to, link));
        transaction.setSelection(TextSelection.create(transaction.doc, from + link.nodeSize));
        view.dispatch(transaction.scrollIntoView());
        view.focus();
      },
    };
    view.dom.setAttribute('aria-controls', wikiListId);
    if (results.length) view.dom.setAttribute('aria-activedescendant', `${wikiListId}-${selected}`);
    else view.dom.removeAttribute('aria-activedescendant');
    publish(menu);
  }

  return new Plugin({
    appendTransaction(transactions, _previous, state) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const { $from } = state.selection;
      if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
      const transaction = state.tr;
      $from.parent.forEach((node, offset) => {
        if (!node.text?.includes('[[') || node.marks.some((mark) => mark.type === state.schema.marks.code || mark.type === state.schema.marks.link)) return;
        for (const link of scanWikiLinks(node.text)) {
          const start = $from.start() + offset;
          transaction.replaceWith(transaction.mapping.map(start + link.start), transaction.mapping.map(start + link.end),
            state.schema.nodes.wiki_link.create({ target: link.target, alias: link.alias }, null, node.marks));
        }
      });
      return transaction.docChanged ? transaction : null;
    },
    props: {
      handleKeyDown(view, event) {
        if (!menu || event.isComposing) return false;
        if (event.key === 'Escape') {
          dismissed = previous;
          sync(view);
        } else if (event.key === 'Enter' && menu.results[selected]) {
          menu.choose(menu.results[selected]);
        } else if (menu.results.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          selected = (selected + menu.results.length + (event.key === 'ArrowDown' ? 1 : -1)) % menu.results.length;
          sync(view);
        } else return false;
        return true;
      },
      handleDOMEvents: {
        focus(view) { queueMicrotask(() => { if (!view.isDestroyed) sync(view); }); return false; },
        blur(view) { sync(view, false); return false; },
        click(_view, event) {
          const button = event.target instanceof Element ? event.target.closest('[data-wiki-target]') : null;
          const target = button?.getAttribute('data-wiki-target');
          if (!target) return false;
          event.preventDefault();
          actions().follow(target);
          return true;
        },
      },
    },
    view(view) {
      const position = () => { if (menu) sync(view); };
      const window = view.dom.ownerDocument.defaultView;
      window?.addEventListener('scroll', position, true);
      window?.addEventListener('resize', position);
      return {
        update: (updated) => sync(updated),
        destroy() {
          window?.removeEventListener('scroll', position, true);
          window?.removeEventListener('resize', position);
          if (menu) publish(null);
          menu = null;
          dismissed = '';
        },
      };
    },
  });
}
