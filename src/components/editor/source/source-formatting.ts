import { redo, undo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { markdownDestination } from '../visual-markdown';
import type { MarkdownAction } from '../toolbar/markdown-toolbar';

const inlineDelimiters = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
  highlight: ['==', '=='],
  superscript: ['^', '^'],
  subscript: ['~', '~'],
  inlineCode: ['`', '`'],
  inlineMath: ['$', '$'],
} as const;

function nextSourceFootnoteId(source: string): string {
  const used = new Set<number>();
  for (const match of source.matchAll(/\[\^(\d+)\]/g)) {
    const num = Number.parseInt(match[1], 10);
    if (Number.isInteger(num) && num > 0) used.add(num);
  }
  let candidate = 1;
  while (used.has(candidate)) candidate++;
  return String(candidate);
}

export function formatSource(source: EditorView, action: MarkdownAction) {
  source.focus();
  if (action.type === 'undo' || action.type === 'redo') {
    (action.type === 'undo' ? undo : redo)(source);
    return;
  }

  const value = source.state.doc.toString();
  const { from: selectionStart, to: selectionEnd } = source.state.selection.main;

  function replace(start: number, end: number, text: string, nextStart: number, nextEnd = nextStart) {
    source.dispatch({
      changes: { from: start, to: end, insert: text },
      selection: { anchor: nextStart, head: nextEnd },
      annotations: Transaction.userEvent.of('input.format'),
      scrollIntoView: true,
    });
  }

  const selected = value.slice(selectionStart, selectionEnd);
  if (action.type === 'link') {
    const label = selected || 'link';
    replace(selectionStart, selectionEnd, `[${label}](${markdownDestination(action.href)})`, selectionStart + 1, selectionStart + 1 + label.length);
    return;
  }

  if (action.type === 'footnote') {
    const id = nextSourceFootnoteId(value);
    const ref = `[^${id}]`;
    const suffix = (value.endsWith('\n\n') ? '' : value.endsWith('\n') ? '\n' : '\n\n') + `[^${id}]: `;
    source.dispatch({
      changes: [
        { from: selectionStart, to: selectionEnd, insert: ref },
        { from: value.length, insert: suffix },
      ],
      selection: { anchor: value.length - (selectionEnd - selectionStart) + ref.length + suffix.length },
      annotations: Transaction.userEvent.of('input.format'),
      scrollIntoView: true,
    });
    return;
  }

  if (action.type in inlineDelimiters) {
    const [before, after] = inlineDelimiters[action.type as keyof typeof inlineDelimiters];
    const start = selectionStart - before.length;
    const end = selectionEnd + after.length;
    if (start >= 0 && value.slice(start, selectionStart) === before && value.slice(selectionEnd, end) === after) {
      replace(start, end, selected, start, start + selected.length);
    } else {
      replace(selectionStart, selectionEnd, before + selected + after, selectionStart + before.length, selectionEnd + before.length);
    }
    return;
  }

  const firstLine = selectionStart === 0 ? 0 : value.lastIndexOf('\n', selectionStart - 1) + 1;
  const lastSelected = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
  const nextBreak = value.indexOf('\n', lastSelected);
  const lastLine = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(firstLine, lastLine).split('\n');
  const markdown = lines.join('\n');

  if (action.type === 'codeBlock' || action.type === 'mathBlock' || action.type === 'mermaid' || action.type === 'divider') {
    if (action.type === 'mermaid') {
      const body = markdown.trim() ? markdown : 'flowchart TD\n  A[Start] --> B[End]';
      const replacement = '```mermaid\n' + body + '\n```';
      replace(firstLine, lastLine, replacement, firstLine + 11, firstLine + 11 + body.length);
      return;
    }
    const replacement = action.type === 'codeBlock'
      ? '```\n' + markdown + '\n```'
      : action.type === 'mathBlock'
        ? '$$\n' + markdown + '\n$$'
        : markdown + (markdown ? '\n\n' : '') + '---\n\n';
    const cursor = action.type === 'codeBlock' ? firstLine + 4 : action.type === 'mathBlock' ? firstLine + 3 : firstLine + replacement.length;
    replace(firstLine, lastLine, replacement, cursor);
    return;
  }

  if (action.type === 'callout') {
    const header = `> [!${action.kind.toUpperCase()}]`;
    const bodyLines = lines.map((line) => `> ${line.replace(/^>[ \t]?/, '')}`);
    const replacement = `${header}\n${bodyLines.join('\n')}`;
    const cursor = firstLine + header.length + 3;
    replace(firstLine, lastLine, replacement, cursor);
    return;
  }

  const prefixes = lines.map((_line, index) => {
    switch (action.type) {
      case 'heading': return action.level ? '#'.repeat(action.level) + ' ' : '';
      case 'bulletList': return '- ';
      case 'orderedList': return `${index + 1}. `;
      case 'quote': return '> ';
      default: return '';
    }
  });
  const marker = action.type === 'heading' ? /^#{1,6}[ \t]+/ : /^(?:[-+*]|\d+[.)]|>)[ \t]+/;
  const replacement = lines.map((line, index) => prefixes[index] + line.replace(marker, '')).join('\n');
  const firstMarkerLength = lines[0].match(marker)?.[0].length ?? 0;
  const cursor = firstLine + prefixes[0].length + Math.max(0, selectionStart - firstLine - firstMarkerLength);
  replace(firstLine, lastLine, replacement, cursor, selectionStart === selectionEnd ? cursor : firstLine + replacement.length);
}
