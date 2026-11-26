import { Node as TiptapNode } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as EditorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type Command } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { renderMermaidDiagram, resetMermaidThemeCache } from './mermaid-render';

const defaultMermaidDiagram = 'flowchart TD\n  A[Start] --> B[Process]\n  B --> C[Done]';

export const mermaidEditMetaKey = new PluginKey<{ openAt: number } | null>('mermaidVisual');

class MermaidNodeView implements NodeView {
  dom: HTMLElement;
  private node: EditorNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly header: HTMLElement;
  private readonly editButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly previewContainer: HTMLElement;
  private readonly editorContainer: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private editing = false;
  private draftCode = '';
  private renderToken = 0;
  private previewTimer: number | null = null;
  private copyTimer: number | null = null;
  private themeObserver: MutationObserver | null = null;

  constructor(node: EditorNode, view: EditorView, getPos: () => number | undefined, startEditing = false) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.draftCode = String(node.attrs.code ?? '');

    this.dom = document.createElement('div');
    this.dom.className = 'mermaid-block-node';
    this.dom.contentEditable = 'false';
    this.dom.setAttribute('data-mermaid-block', '');
    this.dom.setAttribute('data-mermaid-code', this.draftCode);

    this.header = document.createElement('div');
    this.header.className = 'mermaid-block-header';

    const title = document.createElement('span');
    title.className = 'mermaid-block-badge';
    title.textContent = 'Mermaid';

    const actions = document.createElement('div');
    actions.className = 'mermaid-block-actions';

    this.editButton = document.createElement('button');
    this.editButton.type = 'button';
    this.editButton.className = 'mermaid-block-action';
    this.editButton.textContent = 'Edit';
    this.editButton.addEventListener('mousedown', (event) => event.preventDefault());
    this.editButton.addEventListener('click', () => {
      if (this.editing) this.closeEditor(false);
      else this.openEditor();
    });

    this.copyButton = document.createElement('button');
    this.copyButton.type = 'button';
    this.copyButton.className = 'mermaid-block-action';
    this.copyButton.textContent = 'Copy';
    this.copyButton.addEventListener('mousedown', (event) => event.preventDefault());
    this.copyButton.addEventListener('click', () => void this.copySource());

    this.deleteButton = document.createElement('button');
    this.deleteButton.type = 'button';
    this.deleteButton.className = 'mermaid-block-action mermaid-block-delete';
    this.deleteButton.textContent = 'Delete';
    this.deleteButton.addEventListener('mousedown', (event) => event.preventDefault());
    this.deleteButton.addEventListener('click', () => this.deleteNode());

    actions.append(this.editButton, this.copyButton, this.deleteButton);
    this.header.append(title, actions);

    this.previewContainer = document.createElement('div');
    this.previewContainer.className = 'mermaid-preview';
    this.previewContainer.title = 'Double-click to edit diagram';
    this.previewContainer.addEventListener('dblclick', () => {
      if (!this.editing) this.openEditor();
    });

    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'mermaid-editor';
    this.editorContainer.hidden = true;

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'mermaid-source-input';
    this.textarea.setAttribute('aria-label', 'Mermaid diagram source');
    this.textarea.spellcheck = false;
    this.textarea.rows = 6;
    this.textarea.placeholder = defaultMermaidDiagram;
    this.textarea.value = this.draftCode;
    this.textarea.addEventListener('input', () => {
      this.draftCode = this.textarea.value;
      if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
      this.previewTimer = window.setTimeout(() => {
        this.previewTimer = null;
        void this.renderSource(this.draftCode);
      }, 180);
    });
    this.textarea.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeEditor(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.commitSource();
      }
    });

    const footer = document.createElement('div');
    footer.className = 'mermaid-editor-footer';
    const hint = document.createElement('span');
    hint.className = 'mermaid-editor-hint';
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
    hint.textContent = `${isMac ? '⌘' : 'Ctrl+'}Enter to apply · Esc to cancel`;

    const footerButtons = document.createElement('div');
    footerButtons.className = 'mermaid-editor-buttons';

    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'mermaid-block-action';
    this.cancelButton.textContent = 'Cancel';
    this.cancelButton.addEventListener('click', () => this.closeEditor(true));

    this.applyButton = document.createElement('button');
    this.applyButton.type = 'button';
    this.applyButton.className = 'mermaid-block-apply';
    this.applyButton.textContent = 'Apply';
    this.applyButton.addEventListener('click', () => this.commitSource());

    footerButtons.append(this.cancelButton, this.applyButton);
    footer.append(hint, footerButtons);
    this.editorContainer.append(this.textarea, footer);

    this.dom.append(this.header, this.previewContainer, this.editorContainer);

    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      this.themeObserver = new MutationObserver(() => {
        resetMermaidThemeCache();
        void this.renderSource(this.editing ? this.draftCode : String(this.node.attrs.code ?? ''));
      });
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }

    void this.renderSource(this.draftCode);
    if (startEditing) {
      requestAnimationFrame(() => {
        if (this.dom.isConnected) this.openEditor();
      });
    }
  }

  openEditor() {
    this.editing = true;
    this.draftCode = String(this.node.attrs.code ?? '');
    this.textarea.value = this.draftCode;
    this.editorContainer.hidden = false;
    this.dom.setAttribute('data-mermaid-editing', 'true');
    this.editButton.textContent = 'Preview';
    this.textarea.focus();
    const end = this.textarea.value.length;
    this.textarea.setSelectionRange(end, end);
  }

  private closeEditor(restoreFocus: boolean) {
    this.editing = false;
    this.draftCode = String(this.node.attrs.code ?? '');
    this.editorContainer.hidden = true;
    this.dom.removeAttribute('data-mermaid-editing');
    this.editButton.textContent = 'Edit';
    void this.renderSource(this.draftCode);
    if (restoreFocus && !this.view.isDestroyed) this.view.focus();
  }

  private commitSource() {
    const pos = this.getPos();
    if (pos === undefined) {
      this.closeEditor(true);
      return;
    }
    const nextCode = this.textarea.value;
    if (!nextCode.trim()) {
      this.deleteNode();
      return;
    }
    if (nextCode !== String(this.node.attrs.code ?? '')) {
      const tr = closeHistory(this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        code: nextCode,
      }));
      this.view.dispatch(tr.scrollIntoView());
    }
    this.editing = false;
    this.editorContainer.hidden = true;
    this.dom.removeAttribute('data-mermaid-editing');
    this.editButton.textContent = 'Edit';
    void this.renderSource(nextCode);
    if (!this.view.isDestroyed) this.view.focus();
  }

  private deleteNode() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const tr = closeHistory(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
    this.view.dispatch(tr.scrollIntoView());
    if (!this.view.isDestroyed) this.view.focus();
  }

  private async copySource() {
    const text = this.editing ? this.textarea.value : String(this.node.attrs.code ?? '');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    this.copyButton.textContent = 'Copied';
    if (this.copyTimer !== null) window.clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => {
      this.copyButton.textContent = 'Copy';
      this.copyTimer = null;
    }, 1500);
  }

  private async renderSource(source: string) {
    const token = ++this.renderToken;
    if (!source.trim()) {
      this.previewContainer.textContent = '';
      const empty = document.createElement('span');
      empty.className = 'mermaid-empty';
      empty.textContent = 'Empty Mermaid diagram — click Edit to add source';
      this.previewContainer.appendChild(empty);
      return;
    }

    const result = await renderMermaidDiagram(source);
    if (token !== this.renderToken || !this.dom.isConnected) return;
    this.previewContainer.textContent = '';
    if (result.svg === null) {
      const errorBox = document.createElement('div');
      errorBox.className = 'mermaid-error';
      const title = document.createElement('strong');
      title.textContent = 'Diagram syntax error';
      const detail = document.createElement('span');
      detail.textContent = result.error;
      errorBox.append(title, detail);
      this.previewContainer.appendChild(errorBox);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-svg-host';
    wrapper.innerHTML = result.svg;
    this.previewContainer.appendChild(wrapper);
  }

  update(updatedNode: EditorNode) {
    if (updatedNode.type !== this.node.type) return false;
    const nextCode = String(updatedNode.attrs.code ?? '');
    const changed = nextCode !== String(this.node.attrs.code ?? '');
    this.node = updatedNode;
    this.dom.setAttribute('data-mermaid-code', nextCode);
    if (changed && !this.editing) {
      this.draftCode = nextCode;
      this.textarea.value = nextCode;
      void this.renderSource(nextCode);
    }
    return true;
  }

  stopEvent(event: Event) {
    if (this.editing) return true;
    return event.target instanceof Node && this.header.contains(event.target);
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.themeObserver?.disconnect();
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    if (this.copyTimer !== null) window.clearTimeout(this.copyTimer);
  }
}

export const insertMermaidCommand: Command = (state, dispatch) => {
  const { mermaid_block: mermaidBlock, paragraph } = state.schema.nodes;
  const { $from } = state.selection;
  const mermaidNode = mermaidBlock.create({ code: defaultMermaidDiagram });
  let tr = closeHistory(state.tr);
  let nodePos: number;

  if ($from.depth === 1 && $from.parent.type === paragraph && !$from.parent.content.size) {
    nodePos = $from.before();
    const blockEnd = $from.after();
    const hasAfter = Boolean(state.doc.resolve(blockEnd).nodeAfter);
    tr = tr.replaceWith(nodePos, blockEnd, hasAfter ? [mermaidNode] : [mermaidNode, paragraph.create()]);
  } else {
    nodePos = $from.depth ? $from.after(1) : $from.pos;
    tr = tr.insert(nodePos, [mermaidNode, paragraph.create()]);
  }

  const afterPos = Math.min(nodePos + mermaidNode.nodeSize, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos)));
  tr.setMeta(mermaidEditMetaKey, { openAt: nodePos });
  dispatch?.(tr.scrollIntoView());
  return true;
};

export function mermaidVisualPlugin() {
  let pendingOpenAt: number | null = null;
  return new Plugin({
    key: mermaidEditMetaKey,
    state: {
      init: () => null,
      apply(tr) {
        const meta = tr.getMeta(mermaidEditMetaKey) ?? null;
        if (meta) pendingOpenAt = meta.openAt;
        return meta;
      },
    },
    props: {
      nodeViews: {
        mermaid_block: (node, view, getPos) => {
          const pos = getPos();
          const shouldEdit = pos !== undefined && pendingOpenAt === pos;
          if (shouldEdit) pendingOpenAt = null;
          return new MermaidNodeView(node, view, getPos, shouldEdit);
        },
      },
    },
  });
}

export const MermaidBlockExtension = TiptapNode.create({
  name: 'mermaid_block',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-mermaid-code') ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-mermaid-block]' }];
  },

  renderHTML({ node }) {
    return [
      'div',
      { 'data-mermaid-block': '', 'data-mermaid-code': node.attrs.code, contenteditable: 'false' },
      `\`\`\`mermaid\n${node.attrs.code}\n\`\`\``,
    ];
  },

  addProseMirrorPlugins() {
    return [mermaidVisualPlugin()];
  },
});
