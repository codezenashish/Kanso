import { Node as TiptapNode } from '@tiptap/core';
import { lift } from '@tiptap/pm/commands';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as EditorNode } from '@tiptap/pm/model';
import { TextSelection, type Command } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';

const calloutKinds = [
  { id: 'note', label: 'Note' },
  { id: 'tip', label: 'Tip' },
  { id: 'important', label: 'Important' },
  { id: 'warning', label: 'Warning' },
  { id: 'caution', label: 'Caution' },
] as const;

export type CalloutKind = (typeof calloutKinds)[number]['id'];

const calloutIconPaths: Record<CalloutKind, string[]> = {
  note: ['M12 16v-4', 'M12 8h.01', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z'],
  tip: ['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4'],
  important: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M12 7v4', 'M12 15h.01'],
  warning: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z', 'M12 9v4', 'M12 17h.01'],
  caution: ['M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z', 'M12 8v4', 'M12 16h.01'],
};

function createCalloutIcon(kind: CalloutKind): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of calloutIconPaths[kind]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function normalizeCalloutKind(value: unknown): CalloutKind {
  const lower = String(value ?? 'note').toLowerCase();
  return calloutKinds.some((entry) => entry.id === lower) ? (lower as CalloutKind) : 'note';
}

class CalloutNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: EditorNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly header: HTMLElement;
  private readonly iconSlot: HTMLSpanElement;
  private readonly select: HTMLSelectElement;
  private readonly titleSpan: HTMLSpanElement;

  constructor(node: EditorNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    const kind = normalizeCalloutKind(node.attrs.kind);
    this.dom = document.createElement('div');
    this.dom.className = 'editor-callout';
    this.dom.setAttribute('data-callout', kind);
    if (node.attrs.title) {
      this.dom.setAttribute('data-callout-title', String(node.attrs.title));
    }

    this.header = document.createElement('div');
    this.header.className = 'editor-callout-header';
    this.header.contentEditable = 'false';

    this.iconSlot = document.createElement('span');
    this.iconSlot.className = 'editor-callout-icon';

    this.select = document.createElement('select');
    this.select.className = 'editor-callout-select';
    this.select.setAttribute('aria-label', 'Callout type');
    for (const entry of calloutKinds) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      this.select.appendChild(option);
    }
    this.select.addEventListener('change', () => {
      const pos = this.getPos();
      if (pos === undefined) return;
      const nextKind = normalizeCalloutKind(this.select.value);
      const tr = closeHistory(this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        kind: nextKind,
      }));
      this.view.dispatch(tr);
      this.view.focus();
    });

    this.titleSpan = document.createElement('span');
    this.titleSpan.className = 'editor-callout-custom-title';

    this.header.append(this.iconSlot, this.select, this.titleSpan);

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'editor-callout-content';

    this.dom.append(this.header, this.contentDOM);
    this.syncHeader(node);
  }

  private syncHeader(node: EditorNode) {
    const kind = normalizeCalloutKind(node.attrs.kind);
    const title = typeof node.attrs.title === 'string' ? node.attrs.title.trim() : '';
    this.dom.setAttribute('data-callout', kind);
    if (title) this.dom.setAttribute('data-callout-title', title);
    else this.dom.removeAttribute('data-callout-title');

    this.iconSlot.textContent = '';
    this.iconSlot.appendChild(createCalloutIcon(kind));
    this.select.value = kind;
    this.titleSpan.textContent = title;
    this.titleSpan.hidden = !title;
  }

  update(updatedNode: EditorNode) {
    if (updatedNode.type !== this.node.type) return false;
    const headerChanged = updatedNode.attrs.kind !== this.node.attrs.kind || updatedNode.attrs.title !== this.node.attrs.title;
    this.node = updatedNode;
    if (headerChanged) this.syncHeader(updatedNode);
    return true;
  }

  stopEvent(event: Event) {
    return event.target instanceof Node && this.header.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }) {
    if (mutation.type === 'selection') return false;
    return mutation.target === this.dom || this.header.contains(mutation.target);
  }
}

export function applyCalloutCommand(kind: CalloutKind): Command {
  return (state, dispatch) => {
    const { callout, blockquote, paragraph } = state.schema.nodes;
    const { $from } = state.selection;

    for (let depth = $from.depth; depth > 0; depth--) {
      const ancestor = $from.node(depth);
      if (ancestor.type === callout) {
        if (ancestor.attrs.kind === kind) {
          return lift(state, dispatch);
        }
        const pos = $from.before(depth);
        dispatch?.(closeHistory(state.tr.setNodeMarkup(pos, undefined, {
          ...ancestor.attrs,
          kind,
        })).scrollIntoView());
        return true;
      }
      if (ancestor.type === blockquote) {
        const pos = $from.before(depth);
        dispatch?.(closeHistory(state.tr.setNodeMarkup(pos, callout, {
          kind,
          title: null,
          sourceIndex: ancestor.attrs.sourceIndex ?? null,
        })).scrollIntoView());
        return true;
      }
    }

    const range = state.selection.$from.blockRange(state.selection.$to);
    if (range) {
      const tr = closeHistory(state.tr);
      try {
        tr.wrap(range, [{ type: callout, attrs: { kind, title: null } }]);
        dispatch?.(tr.scrollIntoView());
        return true;
      } catch {
        // Fallback below if current selection block cannot wrap directly.
      }
    }

    const insertPos = $from.depth ? $from.after(1) : $from.pos;
    const block = callout.create({ kind }, paragraph.create());
    const tr = closeHistory(state.tr.insert(insertPos, block));
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

export const unwrapEmptyCalloutOnBackspace: Command = (state, dispatch) => {
  const { callout } = state.schema.nodes;
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== 0) return false;

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type !== callout) continue;
    if ($from.index(depth) !== 0) return false;
    return lift(state, dispatch);
  }
  return false;
};

export const CalloutExtension = TiptapNode.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => element.getAttribute('data-callout') ?? 'note',
      },
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-callout-title'),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ node }) {
    return ['div', {
      'data-callout': node.attrs.kind,
      ...(node.attrs.title ? { 'data-callout-title': node.attrs.title } : {}),
    }, 0];
  },

  addNodeView() {
    return ({ node, view, getPos }) => new CalloutNodeView(node, view, getPos);
  },
});
