import { Node as TiptapNode } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as EditorNode } from '@tiptap/pm/model';
import { Plugin, TextSelection, type Command } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';

function flashFootnoteElement(element: unknown) {
  if (!(element instanceof HTMLElement)) return;
  element.setAttribute('data-footnote-active', 'true');
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => {
    element.removeAttribute('data-footnote-active');
  }, 1400);
}

function findMatchingFootnoteDefinition(doc: EditorNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'footnote_definition' && node.attrs.id === id) {
      found = pos;
      return false;
    }
    return undefined;
  });
  return found;
}

function findMatchingFootnoteReference(doc: EditorNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'footnote_reference' && node.attrs.id === id) {
      found = pos;
      return false;
    }
    return undefined;
  });
  return found;
}

function jumpToFootnoteTarget(view: EditorView, targetPos: number, insideText: boolean) {
  const safePos = insideText
    ? Math.min(targetPos + 2, view.state.doc.content.size)
    : Math.min(targetPos + 1, view.state.doc.content.size);
  const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(safePos)));
  view.dispatch(tr);
  view.focus();
  requestAnimationFrame(() => {
    if (!view.isDestroyed) {
      flashFootnoteElement(view.nodeDOM(targetPos));
    }
  });
}

class FootnoteDefinitionNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: EditorNode;
  private readonly view: EditorView;
  private readonly badge: HTMLButtonElement;

  constructor(node: EditorNode, view: EditorView) {
    this.node = node;
    this.view = view;

    this.dom = document.createElement('div');
    this.dom.className = 'editor-footnote-def';
    this.dom.setAttribute('data-footnote-def', String(node.attrs.id ?? '1'));

    this.badge = document.createElement('button');
    this.badge.type = 'button';
    this.badge.className = 'editor-footnote-badge';
    this.badge.contentEditable = 'false';
    this.badge.title = 'Jump to footnote reference';
    this.badge.setAttribute('aria-label', `Jump to footnote ${node.attrs.id} reference`);
    this.badge.textContent = `[^${node.attrs.id}]`;
    this.badge.addEventListener('mousedown', (event) => event.preventDefault());
    this.badge.addEventListener('click', () => {
      const refPos = findMatchingFootnoteReference(this.view.state.doc, String(this.node.attrs.id));
      if (refPos !== null) {
        jumpToFootnoteTarget(this.view, refPos, false);
      }
    });

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'editor-footnote-body';

    this.dom.append(this.badge, this.contentDOM);
  }

  update(updatedNode: EditorNode) {
    if (updatedNode.type !== this.node.type) return false;
    if (updatedNode.attrs.id !== this.node.attrs.id) {
      const id = String(updatedNode.attrs.id ?? '1');
      this.dom.setAttribute('data-footnote-def', id);
      this.badge.textContent = `[^${id}]`;
      this.badge.setAttribute('aria-label', `Jump to footnote ${id} reference`);
    }
    this.node = updatedNode;
    return true;
  }

  stopEvent(event: Event) {
    return event.target instanceof Node && this.badge.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }) {
    if (mutation.type === 'selection') return false;
    return mutation.target === this.dom || this.badge.contains(mutation.target);
  }
}

function nextFootnoteId(doc: EditorNode): string {
  const usedNumbers = new Set<number>();
  doc.descendants((node) => {
    if (node.type.name === 'footnote_reference' || node.type.name === 'footnote_definition') {
      const parsed = Number.parseInt(String(node.attrs.id ?? ''), 10);
      if (Number.isInteger(parsed) && parsed > 0) usedNumbers.add(parsed);
    }
  });
  let candidate = 1;
  while (usedNumbers.has(candidate)) candidate++;
  return String(candidate);
}

export const insertFootnoteCommand: Command = (state, dispatch) => {
  const { footnote_reference: footnoteReference, footnote_definition: footnoteDefinition, paragraph } = state.schema.nodes;
  const id = nextFootnoteId(state.doc);
  const { from, to } = state.selection;
  const refNode = footnoteReference.create({ id });
  const defNode = footnoteDefinition.create({ id }, paragraph.create());

  const tr = closeHistory(state.tr.replaceWith(from, to, refNode));
  const appendAt = tr.doc.content.size;
  tr.insert(appendAt, defNode);
  const cursorPos = Math.min(appendAt + 2, tr.doc.content.size);
  tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch?.(tr.scrollIntoView());
  return true;
};

export const removeEmptyFootnoteOnBackspace: Command = (state, dispatch) => {
  const { footnote_definition: footnoteDefinition } = state.schema.nodes;
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== 0) return false;

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type !== footnoteDefinition) continue;
    if (node.childCount === 1 && !node.firstChild?.content.size) {
      const pos = $from.before(depth);
      const tr = closeHistory(state.tr.delete(pos, pos + node.nodeSize));
      const fallback = Math.max(0, Math.min(pos, tr.doc.content.size));
      tr.setSelection(TextSelection.near(tr.doc.resolve(fallback)));
      dispatch?.(tr.scrollIntoView());
      return true;
    }
    return false;
  }
  return false;
};

export const FootnoteReferenceExtension = TiptapNode.create({
  name: 'footnote_reference',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: '1',
        parseHTML: (element) => element.getAttribute('data-footnote-ref') ?? '1',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'button[data-footnote-ref]' }];
  },

  renderHTML({ node }) {
    return [
      'button',
      { type: 'button', 'data-footnote-ref': node.attrs.id, contenteditable: 'false' },
      `[${node.attrs.id}]`,
    ];
  },
});

export const FootnoteDefinitionExtension = TiptapNode.create({
  name: 'footnote_definition',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      id: {
        default: '1',
        parseHTML: (element) => element.getAttribute('data-footnote-def') ?? '1',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-footnote-def]' }];
  },

  renderHTML({ node }) {
    return ['div', { 'data-footnote-def': node.attrs.id }, 0];
  },

  addNodeView() {
    return ({ node, view }) => new FootnoteDefinitionNodeView(node, view);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClickOn(view, _pos, node, _nodePos, event) {
            if (event.button !== 0 || node.type.name !== 'footnote_reference') return false;
            const targetPos = findMatchingFootnoteDefinition(view.state.doc, String(node.attrs.id));
            if (targetPos === null) return false;
            event.preventDefault();
            jumpToFootnoteTarget(view, targetPos, true);
            return true;
          },
        },
      }),
    ];
  },
});
