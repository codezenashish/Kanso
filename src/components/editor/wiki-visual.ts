import { Extension, Node as TiptapNode } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { scanWikiLinks, wikiLabel } from '@/lib/wiki-markdown';
import type { WikiLinkPreviewInfo, WikiPreviewTrigger } from './wiki-link-preview';
import {
  filterWikiNotes,
  matchWikiInput,
  wikiActiveDescendantId,
  wikiListId,
  wikiMenuOptionCount,
  type WikiCreateSuggestion,
  type WikiMenu,
  type WikiSuggestion,
} from './wiki-suggestions';

export type WikiEditorActions = {
  suggestions: WikiSuggestion[];
  follow: (target: string) => void;
  create: (target: string) => string | null;
  describeCreate: (query: string) => WikiCreateSuggestion | null;
  preview: (target: string, alias?: string | null) => WikiLinkPreviewInfo;
};

export function wikiVisualPlugin(
  actions: () => WikiEditorActions,
  publishMenu: (menu: WikiMenu | null) => void,
  publishPreview: (trigger: WikiPreviewTrigger | null) => void,
) {
  let selected = 0;
  let menu: WikiMenu | null = null;
  let previous = '';
  let dismissed = '';

  let hoverPreview: WikiPreviewTrigger | null = null;
  let focusButtonPreview: WikiPreviewTrigger | null = null;
  let lastEmittedPreview: WikiPreviewTrigger | null = null;

  let nextElementId = 1;
  const elementIds = new WeakMap<Element, number>();
  function keyForButton(button: Element, target: string, alias: string | null) {
    let id = elementIds.get(button);
    if (!id) {
      id = nextElementId++;
      elementIds.set(button, id);
    }
    return `visual:${id}:${target}:${alias ?? ''}`;
  }

  function buildButtonPreview(button: HTMLElement, source: 'hover' | 'focus'): WikiPreviewTrigger | null {
    const target = button.getAttribute('data-wiki-target');
    if (!target) return null;
    const alias = button.getAttribute('data-wiki-alias');
    const rect = button.getBoundingClientRect();
    return {
      target,
      alias,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      source,
      triggerKey: keyForButton(button, target, alias),
      targetElement: button,
    };
  }

  function emitPreview(view: EditorView) {
    if (menu) {
      if (lastEmittedPreview !== null) {
        lastEmittedPreview = null;
        publishPreview(null);
      }
      return;
    }

    let next: WikiPreviewTrigger | null = focusButtonPreview ?? hoverPreview;
    if (!next && view.hasFocus()) {
      const { selection } = view.state;
      if (selection instanceof NodeSelection && selection.node.type.name === 'wiki_link') {
        const dom = view.nodeDOM(selection.from);
        if (dom instanceof HTMLElement) {
          next = buildButtonPreview(dom, 'focus');
        }
      }
    }

    if (
      next?.triggerKey === lastEmittedPreview?.triggerKey
      && next?.source === lastEmittedPreview?.source
      && next?.left === lastEmittedPreview?.left
      && next?.top === lastEmittedPreview?.top
    ) {
      return;
    }
    lastEmittedPreview = next;
    publishPreview(next);
  }

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
        publishMenu(null);
      }
      emitPreview(view);
      return;
    }
    if (signature !== previous) selected = 0;
    previous = signature;
    const currentActions = actions();
    const results = filterWikiNotes(currentActions.suggestions, match.query);
    const create = currentActions.describeCreate(match.query);
    const optionCount = results.length + (create ? 1 : 0);
    selected = Math.min(selected, Math.max(0, optionCount - 1));
    const caret = view.coordsAtPos(selection.from);

    function insertWikiLink(target: string, alias: string | null) {
      if (!match) return;
      const { from, to } = match;
      const link = schema.nodes.wiki_link.create({ target, alias: alias?.trim() || null }, null, marks);
      const transaction = closeHistory(view.state.tr.replaceWith(from, to, link));
      transaction.setSelection(TextSelection.create(transaction.doc, from + link.nodeSize));
      view.dispatch(transaction.scrollIntoView());
      view.focus();
    }

    menu = {
      results,
      create,
      selected,
      left: caret.left,
      top: caret.top,
      bottom: caret.bottom,
      choose(note) {
        insertWikiLink(note.target, match.alias);
      },
      chooseCreate() {
        if (!create) return;
        const createdTarget = actions().create(create.target);
        if (!createdTarget) {
          dismissed = signature;
          sync(view);
          return;
        }
        insertWikiLink(createdTarget, match.alias);
      },
    };
    view.dom.setAttribute('aria-controls', wikiListId);
    const activeDescendant = wikiActiveDescendantId(menu);
    if (activeDescendant) view.dom.setAttribute('aria-activedescendant', activeDescendant);
    else view.dom.removeAttribute('aria-activedescendant');
    publishMenu(menu);
    emitPreview(view);
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
      decorations(state) {
        const decorations: Decoration[] = [];
        const preview = actions().preview;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'wiki_link') return;
          const info = preview(String(node.attrs.target ?? ''), node.attrs.alias ? String(node.attrs.alias) : null);
          if (info.status !== 'resolved') {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-wiki-status': info.status }));
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(view, event) {
        if (!menu || event.isComposing) return false;
        const count = wikiMenuOptionCount(menu);
        if (event.key === 'Escape') {
          dismissed = previous;
          sync(view);
        } else if (event.key === 'Enter' && count) {
          if (selected < menu.results.length) menu.choose(menu.results[selected]);
          else if (menu.create) menu.chooseCreate();
          else return false;
        } else if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          selected = (selected + count + (event.key === 'ArrowDown' ? 1 : -1)) % count;
          sync(view);
        } else return false;
        return true;
      },
      handleDOMEvents: {
        focus(view) { queueMicrotask(() => { if (!view.isDestroyed) sync(view); }); return false; },
        blur(view) {
          queueMicrotask(() => {
            if (view.isDestroyed) return;
            const active = view.dom.ownerDocument.activeElement;
            if (!active || !view.dom.contains(active)) {
              focusButtonPreview = null;
            }
            sync(view, view.hasFocus());
          });
          return false;
        },
        focusin(view, event) {
          const button = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-wiki-target]') : null;
          if (!button) return false;
          focusButtonPreview = buildButtonPreview(button, 'focus');
          emitPreview(view);
          return false;
        },
        focusout(view, event) {
          const leftButton = event.target instanceof HTMLElement ? event.target.closest('[data-wiki-target]') : null;
          if (!leftButton) return false;
          const enteredButton = event.relatedTarget instanceof HTMLElement ? event.relatedTarget.closest('[data-wiki-target]') : null;
          if (enteredButton !== leftButton) {
            focusButtonPreview = null;
            emitPreview(view);
          }
          return false;
        },
        mouseover(view, event) {
          const button = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-wiki-target]') : null;
          if (!button) return false;
          hoverPreview = buildButtonPreview(button, 'hover');
          emitPreview(view);
          return false;
        },
        mouseout(view, event) {
          const leftButton = event.target instanceof HTMLElement ? event.target.closest('[data-wiki-target]') : null;
          if (!leftButton) return false;
          const enteredButton = event.relatedTarget instanceof HTMLElement ? event.relatedTarget.closest('[data-wiki-target]') : null;
          if (enteredButton !== leftButton) {
            hoverPreview = null;
            emitPreview(view);
          }
          return false;
        },
        keydown(_view, event) {
          if (event.isComposing) return false;
          const button = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-wiki-target]') : null;
          if (!button) return false;
          if (event.key === 'Enter' || event.key === ' ') {
            const target = button.getAttribute('data-wiki-target');
            if (!target) return false;
            event.preventDefault();
            event.stopPropagation();
            hoverPreview = null;
            focusButtonPreview = null;
            publishPreview(null);
            actions().follow(target);
            return true;
          }
          return false;
        },
        click(_view, event) {
          const button = event.target instanceof Element ? event.target.closest('[data-wiki-target]') : null;
          const target = button?.getAttribute('data-wiki-target');
          if (!target) return false;
          event.preventDefault();
          hoverPreview = null;
          focusButtonPreview = null;
          publishPreview(null);
          actions().follow(target);
          return true;
        },
      },
    },
    view(view) {
      const position = () => {
        if (menu) sync(view);
        if (hoverPreview || focusButtonPreview) {
          if (hoverPreview?.targetElement?.isConnected) {
            hoverPreview = buildButtonPreview(hoverPreview.targetElement, 'hover');
          } else {
            hoverPreview = null;
          }
          if (focusButtonPreview?.targetElement?.isConnected) {
            focusButtonPreview = buildButtonPreview(focusButtonPreview.targetElement, 'focus');
          } else {
            focusButtonPreview = null;
          }
          emitPreview(view);
        }
      };
      const window = view.dom.ownerDocument.defaultView;
      window?.addEventListener('scroll', position, true);
      window?.addEventListener('resize', position);
      return {
        update: (updated) => sync(updated),
        destroy() {
          window?.removeEventListener('scroll', position, true);
          window?.removeEventListener('resize', position);
          if (menu) publishMenu(null);
          if (lastEmittedPreview) publishPreview(null);
          menu = null;
          hoverPreview = null;
          focusButtonPreview = null;
          lastEmittedPreview = null;
          dismissed = '';
        },
      };
    },
  });
}

export const WikiLinkExtension = TiptapNode.create({
  name: 'wiki_link',
  inline: true,
  group: 'inline',
  atom: true,

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-wiki-target') ?? '',
      },
      alias: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-wiki-alias'),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'button[data-wiki-target]' }];
  },

  renderHTML({ node }) {
    return ['button', {
      type: 'button',
      'data-wiki-target': node.attrs.target,
      'data-wiki-alias': node.attrs.alias,
      contenteditable: 'false',
    }, node.attrs.alias || wikiLabel(node.attrs.target)];
  },
});

export const WikiVisualExtension = Extension.create<{
  getActions: () => WikiEditorActions;
  onMenuChange: (menu: WikiMenu | null) => void;
  onPreviewChange: (trigger: WikiPreviewTrigger | null) => void;
}>({
  name: 'wikiVisual',
  addOptions() {
    return {
      getActions: () => ({
        suggestions: [],
        follow: () => {},
        create: () => null,
        describeCreate: () => null,
        preview: (target, alias = null) => ({
          target,
          alias,
          status: 'missing',
          title: wikiLabel(target),
          path: null,
          snippet: '',
          canCreate: false,
        }),
      }),
      onMenuChange: () => {},
      onPreviewChange: () => {},
    };
  },
  addProseMirrorPlugins() {
    return [wikiVisualPlugin(this.options.getActions, this.options.onMenuChange, this.options.onPreviewChange)];
  },
});
