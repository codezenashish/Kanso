import { Extension, Node as TiptapNode } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Node as EditorNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { renderMathElement } from './math-render';

export type MathMode = 'inline' | 'block';

export type MathEditorSession = {
  isNew: boolean;
  mode: MathMode;
  initialLatex: string;
  anchorRect: { left: number; top: number; right: number; bottom: number };
  apply: (latex: string, mode: MathMode) => void;
  remove?: () => void;
  cancel: () => void;
};

export type MathEditorIntent =
  | { type: 'editNode'; pos: number }
  | { type: 'insert'; mode: MathMode; from: number; to: number; initialLatex: string };

export const mathEditorMetaKey = new PluginKey<MathEditorIntent | null>('mathEditor');

class MathNodeView implements NodeView {
  dom: HTMLElement;
  private node: EditorNode;
  private readonly displayMode: boolean;

  constructor(node: EditorNode, displayMode: boolean) {
    this.node = node;
    this.displayMode = displayMode;
    this.dom = document.createElement(displayMode ? 'div' : 'span');
    this.dom.className = displayMode ? 'math-block-node' : 'math-inline-node';
    this.dom.contentEditable = 'false';
    this.dom.setAttribute(displayMode ? 'data-math-block' : 'data-math-inline', '');
    renderMathElement(this.dom, String(node.attrs.latex ?? ''), displayMode);
  }

  update(updatedNode: EditorNode) {
    if (updatedNode.type !== this.node.type) return false;
    if (updatedNode.attrs.latex !== this.node.attrs.latex) {
      renderMathElement(this.dom, String(updatedNode.attrs.latex ?? ''), this.displayMode);
    }
    this.node = updatedNode;
    return true;
  }

  ignoreMutation() {
    return true;
  }
}

function clampRect(rect: { left: number; top: number; right: number; bottom: number }) {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function hasTextblockAfter(doc: EditorNode, afterPos: number) {
  const next = doc.resolve(afterPos).nodeAfter;
  return Boolean(next && next.isTextblock);
}

export function mathVisualPlugin(publish: (session: MathEditorSession | null) => void) {
  let activeElement: HTMLElement | null = null;
  let activeSession: MathEditorSession | null = null;

  function clearEditingHighlight() {
    if (activeElement) {
      activeElement.removeAttribute('data-math-editing');
      activeElement = null;
    }
  }

  function closeSession(view?: EditorView, restoreFocus = false) {
    clearEditingHighlight();
    if (activeSession) {
      activeSession = null;
      publish(null);
    }
    if (restoreFocus && view && !view.isDestroyed) {
      view.focus();
    }
  }

  function openExistingNode(view: EditorView, pos: number) {
    const { inline_math: inlineMathNode, math_block: mathBlockNode } = view.state.schema.nodes;
    const node = view.state.doc.nodeAt(pos);
    if (!node || (node.type !== inlineMathNode && node.type !== mathBlockNode)) return;
    const mode: MathMode = node.type === mathBlockNode ? 'block' : 'inline';
    const domNode = view.nodeDOM(pos);
    const element = domNode instanceof HTMLElement ? domNode : null;
    const rect = element ? element.getBoundingClientRect() : view.coordsAtPos(pos);

    closeSession();
    if (element) {
      activeElement = element;
      activeElement.setAttribute('data-math-editing', 'true');
    }

    const session: MathEditorSession = {
      isNew: false,
      mode,
      initialLatex: String(node.attrs.latex ?? ''),
      anchorRect: clampRect(rect),
      apply(nextLatex, nextMode) {
        const current = view.state.doc.nodeAt(pos);
        if (!current || (current.type !== inlineMathNode && current.type !== mathBlockNode)) {
          closeSession(view, true);
          return;
        }
        const normalized = nextMode === 'inline' ? nextLatex.replace(/\r?\n/g, ' ') : nextLatex;
        if (!normalized.trim()) {
          const tr = closeHistory(view.state.tr.delete(pos, pos + current.nodeSize));
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
          closeSession();
          view.dispatch(tr.scrollIntoView());
          view.focus();
          return;
        }
        if (normalized !== current.attrs.latex) {
          const tr = closeHistory(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex: normalized }));
          closeSession();
          view.dispatch(tr.scrollIntoView());
          view.focus();
          return;
        }
        closeSession(view, true);
      },
      remove() {
        const current = view.state.doc.nodeAt(pos);
        if (!current) {
          closeSession(view, true);
          return;
        }
        const tr = closeHistory(view.state.tr.delete(pos, pos + current.nodeSize));
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
        closeSession();
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
      cancel() {
        closeSession(view, true);
      },
    };

    activeSession = session;
    publish(session);
  }

  function openInsertSession(view: EditorView, intent: Extract<MathEditorIntent, { type: 'insert' }>) {
    const caret = view.coordsAtPos(intent.from);
    closeSession();

    const session: MathEditorSession = {
      isNew: true,
      mode: intent.mode,
      initialLatex: intent.initialLatex,
      anchorRect: clampRect(caret),
      apply(nextLatex, nextMode) {
        const { state } = view;
        const { inline_math: inlineMathNode, math_block: mathBlockNode, paragraph } = state.schema.nodes;
        const safeFrom = Math.min(intent.from, state.doc.content.size);
        const safeTo = Math.min(intent.to, state.doc.content.size);
        if (!nextLatex.trim()) {
          closeSession(view, true);
          return;
        }

        let tr: Transaction = closeHistory(state.tr);

        if (nextMode === 'inline') {
          const latex = nextLatex.replace(/\r?\n/g, ' ');
          const resolved = state.doc.resolve(safeFrom);
          const marks = state.storedMarks ?? resolved.marks();
          const node = inlineMathNode.create({ latex }, null, marks);
          tr = tr.replaceWith(safeFrom, safeTo, node);
          tr.setSelection(TextSelection.create(tr.doc, safeFrom + node.nodeSize));
        } else {
          const resolved = state.doc.resolve(safeFrom);
          const mathNode = mathBlockNode.create({ latex: nextLatex });
          if (
            safeFrom === safeTo
            && resolved.depth === 1
            && resolved.parent.type === paragraph
            && !resolved.parent.content.size
          ) {
            const blockStart = resolved.before();
            const blockEnd = resolved.after();
            const trailing = hasTextblockAfter(state.doc, blockEnd) ? [] : [paragraph.create()];
            tr = tr.replaceWith(blockStart, blockEnd, [mathNode, ...trailing]);
            const afterMath = Math.min(blockStart + mathNode.nodeSize, tr.doc.content.size);
            tr.setSelection(TextSelection.near(tr.doc.resolve(afterMath)));
          } else {
            tr = tr.replaceRangeWith(safeFrom, safeTo, mathNode);
            const afterMath = Math.min(tr.mapping.map(safeTo), tr.doc.content.size);
            const resolvedAfter = tr.doc.resolve(afterMath);
            if (!resolvedAfter.nodeAfter && resolvedAfter.parent.type === state.schema.nodes.doc) {
              tr = tr.insert(afterMath, paragraph.create());
            }
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(afterMath, tr.doc.content.size))));
          }
        }

        closeSession();
        view.dispatch(tr.scrollIntoView());
        view.focus();
      },
      cancel() {
        closeSession(view, true);
      },
    };

    activeSession = session;
    publish(session);
  }

  return new Plugin<MathEditorIntent | null>({
    key: mathEditorMetaKey,
    state: {
      init: () => null,
      apply(tr) {
        return tr.getMeta(mathEditorMetaKey) ?? null;
      },
    },
    props: {
      handleClickOn(view, _pos, node, nodePos, event) {
        if (event.button !== 0) return false;
        if (node.type.name !== 'inline_math' && node.type.name !== 'math_block') return false;
        event.preventDefault();
        const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos));
        view.dispatch(tr);
        openExistingNode(view, nodePos);
        return true;
      },
      handleTextInput(view, from, to, text) {
        if (text !== '$' || !view.state.selection.empty) return false;
        const { state } = view;
        const { inline_math: inlineMathNode, math_block: mathBlockNode, paragraph } = state.schema.nodes;
        const { $from } = state.selection;
        if ($from.parent.type.spec.code) return false;
        const activeMarks = state.storedMarks ?? $from.marks();
        if (activeMarks.some((mark) => mark.type === state.schema.marks.code || mark.type === state.schema.marks.link)) {
          return false;
        }
        const nodeBefore = $from.nodeBefore;
        if (!nodeBefore?.isText || !nodeBefore.text) return false;
        const before = nodeBefore.text;

        if (
          $from.depth === 1
          && $from.parent.type === paragraph
          && $from.parentOffset === nodeBefore.nodeSize
          && $from.parent.content.size === nodeBefore.nodeSize
        ) {
          const blockMatch = /^\$\$([^\n]+)\$$/.exec(before);
          if (blockMatch && !blockMatch[1].startsWith('$') && !blockMatch[1].endsWith('$') && blockMatch[1].trim()) {
            const blockStart = $from.before();
            const blockEnd = $from.after();
            const mathNode = mathBlockNode.create({ latex: blockMatch[1] });
            const trailing = hasTextblockAfter(state.doc, blockEnd) ? [] : [paragraph.create()];
            const tr = state.tr.replaceWith(blockStart, blockEnd, [mathNode, ...trailing]);
            const afterMath = Math.min(blockStart + mathNode.nodeSize, tr.doc.content.size);
            tr.setSelection(TextSelection.near(tr.doc.resolve(afterMath)));
            view.dispatch(tr.scrollIntoView());
            return true;
          }
        }

        const inlineMatch = /(?:^|[^\\$])\$([^\s$\n](?:[^$\n]*[^\s$\n])?)$/.exec(before);
        if (!inlineMatch) return false;
        const matchStart = before.length - inlineMatch[0].length;
        const dollarIndex = inlineMatch[0].startsWith('$') ? matchStart : matchStart + 1;
        const replaceFrom = from - (before.length - dollarIndex);
        const mathNode = inlineMathNode.create({ latex: inlineMatch[1] }, null, nodeBefore.marks);
        const tr = state.tr.replaceWith(replaceFrom, to, mathNode);
        tr.setSelection(TextSelection.create(tr.doc, replaceFrom + mathNode.nodeSize));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (event.isComposing || view.composing) return false;
        if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
        const { selection, schema } = view.state;
        const { inline_math: inlineMathNode, math_block: mathBlockNode, paragraph } = schema.nodes;
        if (selection instanceof NodeSelection && (selection.node.type === inlineMathNode || selection.node.type === mathBlockNode)) {
          event.preventDefault();
          openExistingNode(view, selection.from);
          return true;
        }
        if (
          selection.empty
          && selection.$from.depth === 1
          && selection.$from.parent.type === paragraph
          && selection.$from.parent.textContent === '$$'
        ) {
          event.preventDefault();
          const from = selection.$from.start();
          const to = selection.$from.end();
          const tr = closeHistory(view.state.tr.delete(from, to));
          tr.setSelection(TextSelection.create(tr.doc, from));
          tr.setMeta(mathEditorMetaKey, {
            type: 'insert',
            mode: 'block',
            from,
            to: from,
            initialLatex: '',
          } satisfies MathEditorIntent);
          view.dispatch(tr);
          return true;
        }
        return false;
      },
    },
    view() {
      return {
        update(updatedView, prevState) {
          const intent = mathEditorMetaKey.getState(updatedView.state);
          if (intent) {
            queueMicrotask(() => {
              if (updatedView.isDestroyed) return;
              if (intent.type === 'editNode') openExistingNode(updatedView, intent.pos);
              else openInsertSession(updatedView, intent);
            });
            return;
          }
          if (activeSession && updatedView.state.doc !== prevState.doc) {
            closeSession();
          }
        },
        destroy() {
          closeSession();
        },
      };
    },
  });
}

export const InlineMathExtension = TiptapNode.create({
  name: 'inline_math',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-math-inline]' }];
  },

  renderHTML({ node }) {
    return [
      'span',
      { 'data-math-inline': '', 'data-latex': node.attrs.latex, contenteditable: 'false' },
      `$${node.attrs.latex}$`,
    ];
  },

  addNodeView() {
    return ({ node }) => new MathNodeView(node, false);
  },
});

export const MathBlockExtension = TiptapNode.create({
  name: 'math_block',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-math-block]' }];
  },

  renderHTML({ node }) {
    return [
      'div',
      { 'data-math-block': '', 'data-latex': node.attrs.latex, contenteditable: 'false' },
      `$$\n${node.attrs.latex}\n$$`,
    ];
  },

  addNodeView() {
    return ({ node }) => new MathNodeView(node, true);
  },
});

export const MathVisualExtension = Extension.create<{
  onSessionChange: (session: MathEditorSession | null) => void;
}>({
  name: 'mathVisual',
  addOptions() {
    return {
      onSessionChange: () => {},
    };
  },
  addProseMirrorPlugins() {
    return [mathVisualPlugin(this.options.onSessionChange)];
  },
});
