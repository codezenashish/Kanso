import { markdownDestination } from './visual-markdown';
import type { MarkdownAction } from './toolbar/markdown-toolbar';

const inlineDelimiters = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
  inlineCode: ['`', '`'],
} as const;

export function formatSource(
  source: HTMLTextAreaElement,
  action: MarkdownAction,
  onChange: (content: string) => void,
) {
  source.focus({ preventScroll: true });
  const { value, selectionStart, selectionEnd } = source;

  function replace(start: number, end: number, text: string, nextStart: number, nextEnd = nextStart) {
    source.setSelectionRange(start, end);
    // Native insertion joins the same undo history as typing and pasting.
    if (!document.execCommand('insertText', false, text)) {
      source.setRangeText(text, start, end);
      onChange(source.value);
    }
    source.setSelectionRange(nextStart, nextEnd);
  }

  if (action.type === 'undo' || action.type === 'redo') {
    document.execCommand(action.type);
    return;
  }

  const selected = value.slice(selectionStart, selectionEnd);
  if (action.type === 'link') {
    const label = selected || 'link';
    replace(selectionStart, selectionEnd, `[${label}](${markdownDestination(action.href)})`, selectionStart + 1, selectionStart + 1 + label.length);
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

  if (action.type === 'codeBlock' || action.type === 'divider') {
    const replacement = action.type === 'codeBlock'
      ? '```\n' + markdown + '\n```'
      : markdown + (markdown ? '\n\n' : '') + '---\n\n';
    const cursor = action.type === 'codeBlock' ? firstLine + 4 : firstLine + replacement.length;
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
