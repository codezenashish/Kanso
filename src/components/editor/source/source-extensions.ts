import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { styleTags, tags } from '@lezer/highlight';
import { highlightCodeTokens } from '../extensions/code-syntax';

import { sourceSearchExtension } from '../search/editor-search';

const sourceHighlighting = HighlightStyle.define([
  { tag: [tags.heading, tags.keyword, tags.atom, tags.bool], class: 'source-syntax-heading' },
  { tag: [tags.link, tags.url], class: 'source-syntax-link' },
  { tag: [tags.monospace, tags.string, tags.number], class: 'source-syntax-literal' },
  { tag: [tags.comment, tags.processingInstruction, tags.quote], class: 'source-syntax-muted' },
  { tag: tags.strong, class: 'source-syntax-strong' },
  { tag: tags.emphasis, class: 'source-syntax-emphasis' },
  { tag: tags.strikethrough, class: 'source-syntax-strike' },
]);

const literalNodes = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Frontmatter', 'DisplayMath']);
const decorationByPrefix = {
  '[': Decoration.mark({ class: 'source-syntax-link' }),
  '$': Decoration.mark({ class: 'source-syntax-literal' }),
  '=': Decoration.mark({ class: 'source-syntax-highlight' }),
  '^': Decoration.mark({ class: 'source-syntax-literal' }),
  '~': Decoration.mark({ class: 'source-syntax-literal' }),
};

const kansoSyntaxMatches = new MatchDecorator({
  regexp: /\[\[[^\[\]\n]+\]\]|\[\^[^\]\n]+\]|\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]|\$\$[^$\n]*\$\$|\$[^$\n]+\$|==[^=\n]+==|\^[^\s^]+\^|(?<!~)~[^\s~]+~(?!~)/gi,
  decoration(match, view, from) {
    for (let node = syntaxTree(view.state).resolveInner(from, 1); node; ) {
      if (literalNodes.has(node.name)) return null;
      if (!node.parent) break;
      node = node.parent;
    }
    return decorationByPrefix[match[0][0] as keyof typeof decorationByPrefix];
  },
});

const kansoSyntax = ViewPlugin.fromClass(class {
  decorations;
  constructor(view: EditorView) {
    this.decorations = kansoSyntaxMatches.createDeco(view);
  }
  update(update: ViewUpdate) {
    this.decorations = syntaxTree(update.startState) !== syntaxTree(update.state)
      ? kansoSyntaxMatches.createDeco(update.view)
      : kansoSyntaxMatches.updateDeco(update, this.decorations);
  }
}, { decorations: (plugin) => plugin.decorations });

function fencedCodeDecorations(view: EditorView) {
  const { state } = view;
  const decorations: ReturnType<Decoration['range']>[] = [];
  for (const range of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter(cursor) {
        if (cursor.name !== 'CodeText' || cursor.node.parent?.name !== 'FencedCode') return;
        const info = cursor.node.parent.getChild('CodeInfo');
        if (!info) return;
        const language = state.sliceDoc(info.from, info.to);
        const from = Math.max(cursor.from, range.from);
        const to = Math.min(cursor.to, range.to);
        for (let position = from; position < to;) {
          const line = state.doc.lineAt(position);
          const start = Math.max(line.from, cursor.from);
          const end = Math.min(line.to, cursor.to);
          for (const token of highlightCodeTokens(state.sliceDoc(start, end), language)) {
            decorations.push(Decoration.mark({ class: token.className }).range(start + token.from, start + token.to));
          }
          position = line.to + 1;
        }
      },
    });
  }
  return Decoration.set(decorations, true);
}

const fencedCodeSyntax = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = fencedCodeDecorations(view);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = fencedCodeDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

export function sourceExtensions(label: string | undefined): Extension[] {
  const language = label === 'YAML source'
    ? yaml()
    : label ? [] : [yamlFrontmatter({ content: markdown({
      base: markdownLanguage,
      addKeymap: false,
      completeHTMLTags: false,
      pasteURLAsLink: false,
      extensions: {
        defineNodes: ['DisplayMath'],
        props: [styleTags({ DisplayMath: tags.monospace })],
        parseBlock: [{
          name: 'DisplayMath',
          parse(context, line) {
            const marker = line.text.slice(line.pos).trimEnd();
            if (!/^\$\$(?:.*\$\$)?$/.test(marker) || line.indent >= line.baseIndent + 4) return false;
            const from = context.lineStart + line.pos;
            if (marker === '$$') {
              while (context.nextLine() && line.text.slice(line.pos).trimEnd() !== '$$') {
                // The next line is part of the display equation.
              }
            }
            context.nextLine();
            context.addElement(context.elt('DisplayMath', from, context.prevLineEnd()));
            return true;
          },
        }],
      },
    }) }), kansoSyntax, fencedCodeSyntax];

  return [
    language,
    syntaxHighlighting(sourceHighlighting),
    history(),
    sourceSearchExtension,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      'aria-label': label ?? 'Markdown source',
      'aria-multiline': 'true',
      spellcheck: 'false',
    }),
  ];
}
