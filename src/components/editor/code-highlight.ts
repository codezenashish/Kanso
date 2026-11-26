import { closeHistory } from '@tiptap/pm/history';
import type { Node as EditorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@tiptap/pm/view';
import { highlightCodeTokens } from './extensions/code-syntax';
import { getSettings } from '@/lib/settings';

const codeLanguages = [
  { id: '', label: 'Plain text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'sql', label: 'SQL' },
  { id: 'bash', label: 'Bash' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'mermaid', label: 'Mermaid' },
] as const;

const canonicalDisplayLanguage: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  xml: 'html',
  htm: 'html',
  xhtml: 'html',
  svg: 'html',
  yml: 'yaml',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  md: 'markdown',
};

function normalizeCodeLanguageChoice(params: string | null | undefined): string {
  const token = String(params ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return canonicalDisplayLanguage[token] ?? token;
}

const codeTokensByBlock = new WeakMap<EditorNode, ReturnType<typeof highlightCodeTokens>>();

function buildCodeDecorations(doc: EditorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return;
    let tokens = codeTokensByBlock.get(node);
    if (!tokens) {
      tokens = highlightCodeTokens(node.textContent, node.attrs.params);
      codeTokensByBlock.set(node, tokens);
    }
    for (const token of tokens) {
      decorations.push(Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, { class: token.className }));
    }
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

const codeHighlightKey = new PluginKey<DecorationSet>('codeHighlight');

export function codeHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: (_config, state) => buildCodeDecorations(state.doc),
      apply(tr, previous) {
        return tr.docChanged ? buildCodeDecorations(tr.doc) : previous;
      },
    },
    props: {
      decorations(state) {
        return codeHighlightKey.getState(state);
      },
    },
  });
}

function createSvgIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const copyIconPaths = [
  'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
  'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
];
const checkIconPaths = ['M20 6 9 17l-5-5'];
const wrapIconPaths = [
  'M3 6h18',
  'M3 12h15a3 3 0 1 1 0 6h-4',
  'm16 16-2 2 2 2',
  'M3 18h7',
];
const lineNumberIconPaths = [
  'M10 6h11',
  'M10 12h11',
  'M10 18h11',
  'M4 6h1v4',
  'M4 10h2',
  'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
];

function findTextPositionAtOffset(codeEl: HTMLElement, targetOffset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let lastText: Text | null = null;
  let current = walker.nextNode() as Text | null;
  while (current) {
    lastText = current;
    const len = current.data.length;
    if (consumed + len >= targetOffset) {
      return { node: current, offset: targetOffset - consumed };
    }
    consumed += len;
    current = walker.nextNode() as Text | null;
  }
  return lastText ? { node: lastText, offset: lastText.data.length } : null;
}

export class CodeBlockNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: EditorNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly header: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly gutter: HTMLElement;
  private readonly pre: HTMLElement;
  private readonly wrapButton: HTMLButtonElement;
  private readonly lineNumberButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly copyLabel: HTMLSpanElement;
  private readonly copyIconSlot: HTMLSpanElement;
  private copyResetTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private showLineNumbers: boolean;
  private wordWrap: boolean;
  private rafHandle: number | null = null;

  constructor(node: EditorNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    const codeBlockPreferences = getSettings();
    this.showLineNumbers = codeBlockPreferences.codeBlockLineNumbers;
    this.wordWrap = codeBlockPreferences.codeBlockWordWrap;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = 'code-block-node';
    this.dom.setAttribute('data-wrap', String(this.wordWrap));
    this.dom.setAttribute('data-line-numbers', String(this.showLineNumbers));

    this.header = document.createElement('div');
    this.header.className = 'code-block-header';
    this.header.contentEditable = 'false';

    this.select = document.createElement('select');
    this.select.className = 'code-block-lang-select';
    this.select.setAttribute('aria-label', 'Code language');
    this.populateLanguageOptions(String(node.attrs.params ?? ''));
    this.select.addEventListener('change', () => this.handleLanguageChange());

    const actions = document.createElement('div');
    actions.className = 'code-block-actions';

    this.lineNumberButton = document.createElement('button');
    this.lineNumberButton.type = 'button';
    this.lineNumberButton.className = 'code-block-action';
    this.lineNumberButton.title = 'Toggle line numbers';
    this.lineNumberButton.setAttribute('aria-label', 'Toggle line numbers');
    this.lineNumberButton.setAttribute('aria-pressed', String(this.showLineNumbers));
    this.lineNumberButton.appendChild(createSvgIcon(lineNumberIconPaths));
    this.lineNumberButton.addEventListener('mousedown', (event) => event.preventDefault());
    this.lineNumberButton.addEventListener('click', () => {
      this.showLineNumbers = !this.showLineNumbers;
      this.dom.setAttribute('data-line-numbers', String(this.showLineNumbers));
      this.lineNumberButton.setAttribute('aria-pressed', String(this.showLineNumbers));
      this.scheduleGutterSync();
    });

    this.wrapButton = document.createElement('button');
    this.wrapButton.type = 'button';
    this.wrapButton.className = 'code-block-action';
    this.wrapButton.title = 'Toggle word wrap';
    this.wrapButton.setAttribute('aria-label', 'Toggle word wrap');
    this.wrapButton.setAttribute('aria-pressed', String(this.wordWrap));
    this.wrapButton.appendChild(createSvgIcon(wrapIconPaths));
    this.wrapButton.addEventListener('mousedown', (event) => event.preventDefault());
    this.wrapButton.addEventListener('click', () => {
      this.wordWrap = !this.wordWrap;
      this.dom.setAttribute('data-wrap', String(this.wordWrap));
      this.wrapButton.setAttribute('aria-pressed', String(this.wordWrap));
      this.scheduleGutterSync();
    });

    this.copyButton = document.createElement('button');
    this.copyButton.type = 'button';
    this.copyButton.className = 'code-block-action code-block-copy';
    this.copyButton.title = 'Copy code';
    this.copyButton.setAttribute('aria-label', 'Copy code');
    this.copyIconSlot = document.createElement('span');
    this.copyIconSlot.className = 'inline-flex items-center';
    this.copyIconSlot.appendChild(createSvgIcon(copyIconPaths));
    this.copyLabel = document.createElement('span');
    this.copyLabel.textContent = 'Copy';
    this.copyButton.append(this.copyIconSlot, this.copyLabel);
    this.copyButton.addEventListener('mousedown', (event) => event.preventDefault());
    this.copyButton.addEventListener('click', () => void this.copyCode());

    actions.append(this.lineNumberButton, this.wrapButton, this.copyButton);
    this.header.append(this.select, actions);

    const body = document.createElement('div');
    body.className = 'code-block-body';

    this.gutter = document.createElement('div');
    this.gutter.className = 'code-block-gutter';
    this.gutter.contentEditable = 'false';
    this.gutter.setAttribute('aria-hidden', 'true');

    this.pre = document.createElement('pre');
    this.pre.className = 'code-block-pre';
    this.contentDOM = document.createElement('code');
    this.contentDOM.className = 'code-block-content';
    this.pre.appendChild(this.contentDOM);

    body.append(this.gutter, this.pre);
    this.dom.append(this.header, body);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.showLineNumbers && this.wordWrap) this.scheduleGutterSync();
      });
      this.resizeObserver.observe(this.pre);
    }
  }

  private populateLanguageOptions(params: string) {
    const current = normalizeCodeLanguageChoice(params);
    this.select.textContent = '';
    let hasCurrent = false;
    for (const entry of codeLanguages) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      if (entry.id === current) hasCurrent = true;
      this.select.appendChild(option);
    }
    if (current && !hasCurrent) {
      const custom = document.createElement('option');
      custom.value = current;
      custom.textContent = current;
      this.select.appendChild(custom);
    }
    this.select.value = current;
  }

  private handleLanguageChange() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const chosen = this.select.value;
    if (chosen === 'mermaid') {
      const mermaidBlock = this.view.state.schema.nodes.mermaid_block;
      const mermaidNode = mermaidBlock.create({ code: this.node.textContent });
      const tr = closeHistory(this.view.state.tr.replaceWith(pos, pos + this.node.nodeSize, mermaidNode));
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + mermaidNode.nodeSize, tr.doc.content.size))));
      this.view.dispatch(tr);
      this.view.focus();
      return;
    }

    const existingParts = String(this.node.attrs.params ?? '').trim().split(/\s+/).filter(Boolean);
    const metaParts = existingParts.slice(1);
    const nextParams = [chosen, ...metaParts].filter(Boolean).join(' ');
    const tr = closeHistory(this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      params: nextParams,
    }));
    this.view.dispatch(tr);
    this.view.focus();
  }

  private async copyCode() {
    const text = this.node.textContent;
    try {
      await navigator.clipboard.writeText(text);
      this.showCopiedFeedback();
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
      this.showCopiedFeedback();
    }
  }

  private showCopiedFeedback() {
    this.copyIconSlot.textContent = '';
    this.copyIconSlot.appendChild(createSvgIcon(checkIconPaths));
    this.copyLabel.textContent = 'Copied';
    this.copyButton.setAttribute('data-copied', 'true');
    if (this.copyResetTimer !== null) window.clearTimeout(this.copyResetTimer);
    this.copyResetTimer = window.setTimeout(() => {
      this.copyIconSlot.textContent = '';
      this.copyIconSlot.appendChild(createSvgIcon(copyIconPaths));
      this.copyLabel.textContent = 'Copy';
      this.copyButton.removeAttribute('data-copied');
      this.copyResetTimer = null;
    }, 1500);
  }

  private scheduleGutterSync() {
    if (!this.showLineNumbers) return;
    this.syncGutter();
    if (!this.wordWrap || typeof requestAnimationFrame === 'undefined') return;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.syncGutter();
    });
  }

  private syncGutter() {
    if (!this.showLineNumbers) return;
    const lines = this.node.textContent.split('\n');
    const heights: number[] = [];

    if (this.wordWrap && this.contentDOM.isConnected) {
      const codeRect = this.contentDOM.getBoundingClientRect();
      const computedLine = parseFloat(getComputedStyle(this.contentDOM).lineHeight) || 22;
      let startOffset = 0;
      for (const line of lines) {
        const endOffset = startOffset + line.length;
        let lineHeight = computedLine;
        if (line.length > 0) {
          const startPos = findTextPositionAtOffset(this.contentDOM, startOffset);
          const endPos = findTextPositionAtOffset(this.contentDOM, endOffset);
          if (startPos && endPos) {
            const range = document.createRange();
            range.setStart(startPos.node, startPos.offset);
            range.setEnd(endPos.node, endPos.offset);
            const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
            if (rects.length > 0 && codeRect.height > 0) {
              const top = Math.min(...rects.map((rect) => rect.top));
              const bottom = Math.max(...rects.map((rect) => rect.bottom));
              lineHeight = Math.max(computedLine, Math.round((bottom - top) * 100) / 100);
            }
          }
        }
        heights.push(lineHeight);
        startOffset = endOffset + 1;
      }
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lines.length; index++) {
      const span = document.createElement('span');
      span.className = 'code-block-line-number';
      span.textContent = String(index + 1);
      if (heights[index] !== undefined) {
        span.style.height = `${heights[index]}px`;
      }
      fragment.appendChild(span);
    }
    this.gutter.textContent = '';
    this.gutter.appendChild(fragment);
  }

  update(updatedNode: EditorNode) {
    if (updatedNode.type !== this.node.type) return false;
    const paramsChanged = updatedNode.attrs.params !== this.node.attrs.params;
    const textChanged = updatedNode.textContent !== this.node.textContent;
    this.node = updatedNode;
    if (paramsChanged) this.populateLanguageOptions(String(updatedNode.attrs.params ?? ''));
    if (textChanged && this.showLineNumbers) this.scheduleGutterSync();
    return true;
  }

  stopEvent(event: Event) {
    const target = event.target;
    return target instanceof Node && (this.header.contains(target) || this.gutter.contains(target));
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }) {
    if (mutation.type === 'selection') return false;
    const target = mutation.target;
    if (target === this.dom || this.header.contains(target) || this.gutter.contains(target)) return true;
    return false;
  }

  destroy() {
    this.resizeObserver?.disconnect();
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    if (this.copyResetTimer !== null) window.clearTimeout(this.copyResetTimer);
  }
}
