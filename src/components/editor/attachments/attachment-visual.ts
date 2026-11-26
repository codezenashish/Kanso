import { Node as TiptapNode } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as EditorNode } from '@tiptap/pm/model';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { attachmentErrorMessage, openAttachment, readAttachmentImage, resolveAttachment } from '@/lib/database/attachment-database';
import { attachmentDestination, readAttachmentAttrs, type AttachmentAttrs } from './attachment-markdown';

function textElement(className: string) {
  const span = document.createElement('span');
  span.className = className;
  return span;
}

class ManagedAttachmentView implements NodeView {
  readonly dom = textElement('managed-attachment');
  private readonly status = textElement('attachment-status');
  private readonly label = textElement('attachment-label');
  private readonly caption = textElement('attachment-caption');
  private readonly image = document.createElement('img');
  private readonly controls = textElement('attachment-controls');
  private readonly openButton = document.createElement('button');
  private readonly resize = document.createElement('select');
  private readonly align = document.createElement('select');
  private readonly alt = document.createElement('input');
  private readonly captionInput = document.createElement('input');
  private objectUrl?: string;
  private observer?: IntersectionObserver;
  private destroyed = false;
  private readonly attrs: AttachmentAttrs;

  constructor(node: EditorNode, view: EditorView, getPos: () => number | undefined, noteId: string) {
    this.attrs = node.attrs as AttachmentAttrs;
    this.dom.contentEditable = 'false';
    this.dom.dataset.kind = this.attrs.kind;
    this.status.setAttribute('role', 'status');
    this.status.textContent = 'Loading attachment…';
    this.controls.dataset.attachmentControls = '';
    this.image.hidden = true;
    this.image.decoding = 'async';
    this.image.draggable = false;
    this.image.onload = () => {
      this.image.hidden = false;
      this.status.textContent = '';
    };
    this.image.onerror = () => { this.status.textContent = 'The attached image could not be displayed.'; };
    this.openButton.type = 'button';
    this.openButton.disabled = true;
    this.openButton.textContent = 'Open file';
    this.openButton.onclick = async () => {
      this.status.textContent = '';
      try {
        await openAttachment(noteId, this.attrs.id);
      } catch (error) {
        this.status.textContent = attachmentErrorMessage(error);
      }
    };

    function changeAttributes(patch: Partial<AttachmentAttrs>) {
      const position = getPos();
      if (position === undefined) return;
      const current = view.state.doc.nodeAt(position);
      if (current?.type !== node.type) return;
      view.dispatch(closeHistory(view.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, ...patch })));
    }

    const display = textElement('attachment-display');
    if (this.attrs.kind === 'image') {
      display.append(this.image, this.caption, this.status);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Image options';
      edit.setAttribute('aria-expanded', 'false');
      const options = textElement('attachment-options');
      options.hidden = true;
      edit.onclick = () => {
        options.hidden = !options.hidden;
        edit.setAttribute('aria-expanded', String(!options.hidden));
      };
      this.alt.onchange = () => changeAttributes({ label: this.alt.value });
      this.captionInput.onchange = () => changeAttributes({ title: this.captionInput.value || null });
      this.resize.onchange = () => changeAttributes({ width: Number(this.resize.value) || null });
      this.align.onchange = () => changeAttributes({ align: this.align.value as AttachmentAttrs['align'] || null });
      this.align.append(new Option('Inline', ''), new Option('Left', 'left'), new Option('Center', 'center'), new Option('Right', 'right'));
      for (const [label, field] of [
        ['Alt text', this.alt], ['Caption', this.captionInput], ['Width', this.resize], ['Alignment', this.align],
      ] as const) {
        const wrapper = document.createElement('label');
        wrapper.append(label, field);
        options.append(wrapper);
      }
      this.controls.append(edit, options);
    } else {
      display.append(this.label, this.status);
      this.controls.append(this.openButton);
    }
    this.dom.append(display, this.controls);
    this.render(this.attrs);

    if (this.attrs.kind === 'image' && typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        this.observer?.disconnect();
        void this.load(noteId);
      }, { rootMargin: '240px' });
      this.observer.observe(this.dom);
    } else {
      void this.load(noteId);
    }
  }

  private render(attrs: AttachmentAttrs) {
    this.image.alt = attrs.label;
    this.alt.value = attrs.label;
    this.caption.textContent = attrs.title ?? '';
    this.captionInput.value = attrs.title ?? '';
    this.caption.hidden = !attrs.title;
    this.label.textContent = attrs.label || 'Attachment';
    this.dom.dataset.align = attrs.align ?? '';
    this.dom.style.setProperty('--attachment-width', attrs.width === null ? 'fit-content' : `${attrs.width}%`);
    this.align.value = attrs.align ?? '';
    if (attrs.kind === 'image') {
      const widths = [...new Set([25, 50, 75, 100, ...(attrs.width === null ? [] : [attrs.width])])].sort((a, b) => a - b);
      this.resize.replaceChildren(new Option('Original', ''), ...widths.map((width) => new Option(`${width}%`, String(width))));
      this.resize.value = attrs.width?.toString() ?? '';
    }
  }

  private async load(noteId: string, retries = 2) {
    try {
      if (this.attrs.kind === 'image') {
        const blob = await readAttachmentImage(noteId, this.attrs.id);
        if (this.destroyed) return;
        this.objectUrl = URL.createObjectURL(blob);
        this.image.src = this.objectUrl;
      } else {
        const file = await resolveAttachment(noteId, this.attrs.id);
        if (this.destroyed) return;
        this.openButton.textContent = file.mimeType === 'application/pdf' ? 'Open PDF' : 'Open file';
        this.openButton.setAttribute('aria-label', `${this.openButton.textContent}: ${file.originalFilename}`);
        this.openButton.disabled = false;
        this.status.textContent = '';
      }
    } catch (error) {
      // A reference pasted from another note becomes available after autosave indexes it.
      if (error === 'attachmentNotFound' && retries > 0 && !this.destroyed) {
        window.setTimeout(() => { if (!this.destroyed) void this.load(noteId, retries - 1); }, 400);
      } else if (!this.destroyed) {
        this.status.textContent = attachmentErrorMessage(error);
      }
    }
  }

  update(next: EditorNode) {
    if (next.type.name !== 'managed_attachment' || next.attrs.id !== this.attrs.id || next.attrs.kind !== this.attrs.kind) return false;
    this.render(next.attrs as AttachmentAttrs);
    return true;
  }

  stopEvent(event: Event) {
    return event.target instanceof Element && Boolean(event.target.closest('[data-attachment-controls]'));
  }

  ignoreMutation() { return true; }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

export const ManagedAttachmentExtension = TiptapNode.create<{ noteId: string }>({
  name: 'managed_attachment',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions: () => ({ noteId: '' }),

  addAttributes: () => ({
    id: { default: '', rendered: false },
    kind: { default: 'file', rendered: false },
    label: { default: '', rendered: false },
    title: { default: null, rendered: false },
    width: { default: null, rendered: false },
    align: { default: null, rendered: false },
  }),

  parseHTML() {
    return [{
      tag: 'span[data-managed-attachment]',
      getAttrs: (element) => {
        const kind = element.getAttribute('data-attachment-kind') === 'image' ? 'image' : 'file';
        return readAttachmentAttrs(element.getAttribute('data-managed-attachment') ?? '', kind,
          element.getAttribute('data-attachment-label') ?? '', element.getAttribute('data-attachment-title')) ?? false;
      },
    }];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as AttachmentAttrs;
    return ['span', {
      'data-managed-attachment': attachmentDestination(attrs),
      'data-attachment-kind': attrs.kind,
      'data-attachment-label': attrs.label,
      'data-attachment-title': attrs.title,
    }, attrs.label || 'Attachment'];
  },

  addNodeView() {
    return ({ node, view, getPos }) => new ManagedAttachmentView(node, view, getPos, this.options.noteId);
  },
});
