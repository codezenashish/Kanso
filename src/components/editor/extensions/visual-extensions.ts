import { visualSearchExtension } from '../search/editor-search';
import { Extension, Node as TiptapNode, getSchema, textblockTypeInputRule } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import Document from '@tiptap/extension-document';
import { ListItem } from '@tiptap/extension-list';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { chainCommands } from '@tiptap/pm/commands';
import { splitListItem } from '@tiptap/pm/schema-list';
import { Plugin, Selection, type Command } from '@tiptap/pm/state';
import { addRowAfter, goToNextCell } from '@tiptap/pm/tables';
import StarterKit from '@tiptap/starter-kit';
import { ManagedAttachmentExtension } from '../attachments/attachment-visual';
import { CalloutExtension, unwrapEmptyCalloutOnBackspace } from '../callout-visual';
import { CodeBlockNodeView, codeHighlightPlugin } from '../code-highlight';
import { CollapsibleSectionsExtension } from '../collapsible-sections';
import { FloatingToolbarExtension, type FloatingToolbarState } from '../floating-toolbar';
import { FootnoteDefinitionExtension, FootnoteReferenceExtension, removeEmptyFootnoteOnBackspace } from '../footnote-visual';
import { InlineMathExtension, MathBlockExtension, MathVisualExtension, type MathEditorSession } from '../math-visual';
import { MermaidBlockExtension } from '../mermaid-visual';
import { SlashCommandExtension, type SlashMenuState } from '../slash-menu';
import type { MarkdownAction } from '../toolbar/markdown-toolbar';
import { pasteVisualMarkdown } from '../visual-paste';
import type { WikiPreviewTrigger } from '../wiki-link-preview';
import type { WikiMenu } from '../wiki-suggestions';
import { WikiLinkExtension, WikiVisualExtension, type WikiEditorActions } from '../wiki-visual';

export function safeHref(href: string) {
  try {
    return /^(?:https?:|mailto:|tel:)$/i.test(new URL(href, 'https://workspace.invalid').protocol);
  } catch {
    return false;
  }
}

const backtickCodeRegex = /^```([^\s`]+)?[\s\n]$/;
const tildeCodeRegex = /^~~~([^\s~]+)?[\s\n]$/;

const KansoDocument = Document.extend({
  content: 'yaml_frontmatter? block+',
});

const KansoCodeBlock = CodeBlock.configure({
  exitOnArrowUp: false,
}).extend({

  addAttributes() {
    return {
      params: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-params') ?? '',
      },
    };
  },

  renderHTML({ node }) {
    return ['pre', node.attrs.params ? { 'data-params': node.attrs.params } : {}, ['code', 0]];
  },

  addNodeView() {
    return ({ node, view, getPos }) => new CodeBlockNodeView(node, view, getPos);
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: backtickCodeRegex,
        type: this.type,
        getAttributes: (match) => ({ params: match[1] ?? '' }),
      }),
      textblockTypeInputRule({
        find: tildeCodeRegex,
        type: this.type,
        getAttributes: (match) => ({ params: match[1] ?? '' }),
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [codeHighlightPlugin()];
  },
});

const KansoListItem = ListItem.extend({
  content: 'block+',

  addAttributes() {
    return {
      checked: {
        default: null,
        parseHTML: (element) => (
          element.hasAttribute('data-task') ? element.getAttribute('data-task') === 'true' : null
        ),
      },
    };
  },

  renderHTML({ node }) {
    if (node.attrs.checked === null) return ['li', 0];
    return [
      'li',
      { 'data-task': String(node.attrs.checked) },
      [
        'span',
        { contenteditable: 'false', class: 'grid h-lh place-items-center' },
        [
          'input',
          {
            type: 'checkbox',
            checked: node.attrs.checked ? '' : null,
            'aria-label': 'Toggle task',
            class: 'size-4 cursor-pointer rounded-sm accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          },
        ],
      ],
      ['div', { 'data-task-content': '', class: 'min-w-0' }, 0],
    ];
  },

  addKeyboardShortcuts() {
    const shortcuts = this.parent?.();
    return {
      ...shortcuts,
      Enter: (context) => {
        const { $from } = this.editor.state.selection;
        const item = $from.depth > 1 ? $from.node(-1) : null;
        if (item?.type === this.type && item.attrs.checked !== null) {
          return this.editor.commands.command(({ state, dispatch }) => (
            splitListItem(this.type, { checked: false })(state, dispatch)
          ));
        }
        return shortcuts?.Enter?.(context) ?? false;
      },
    };
  },
});

const advanceTableCell: Command = chainCommands(goToNextCell(1), (state, dispatch) => (
  addRowAfter(state, dispatch && ((transaction) => {
    goToNextCell(1)(state.apply(transaction), (next) => {
      transaction.setSelection(Selection.fromJSON(transaction.doc, next.selection.toJSON()));
    });
    dispatch(transaction.scrollIntoView());
  }))
));

const KansoTable = Table.configure({
  resizable: false,
  renderWrapper: false,
  View: null,
}).extend({
  renderHTML() {
    return ['div', { class: 'editor-table-scroll' }, ['table', ['tbody', 0]]];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'editor-table-scroll';
      const table = dom.appendChild(document.createElement('table'));
      const contentDOM = table.appendChild(document.createElement('tbody'));
      return {
        dom,
        contentDOM,
        update: (nextNode) => nextNode.type === node.type,
      };
    };
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Tab: () => this.editor.commands.command(({ state, dispatch }) => advanceTableCell(state, dispatch)),
      'Shift-Tab': () => this.editor.commands.command(({ state, dispatch }) => goToNextCell(-1)(state, dispatch)),
    };
  },
});

function createTableAlignAttribute() {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const attr = element.getAttribute('data-align') || element.style.textAlign || element.getAttribute('align');
      return attr === 'left' || attr === 'center' || attr === 'right' ? attr : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes.align;
      if (value === 'left' || value === 'center' || value === 'right') {
        return { 'data-align': value, style: `text-align: ${value}` };
      }
      return {};
    },
  };
}

const KansoTableCell = TableCell.extend({
  content: 'paragraph',
  addAttributes() {
    return {
      ...this.parent?.(),
      align: createTableAlignAttribute(),
    };
  },
});

const KansoTableHeader = TableHeader.extend({
  content: 'paragraph',
  addAttributes() {
    return {
      ...this.parent?.(),
      align: createTableAlignAttribute(),
    };
  },
});

export const YamlFrontmatterExtension = TiptapNode.create({
  name: 'yaml_frontmatter',
  atom: true,
  isolating: true,
  selectable: false,

  addAttributes() {
    return {
      source: { default: '' },
    };
  },

  renderHTML() {
    return ['div', { hidden: '', contenteditable: 'false' }];
  },
});

export const PreservedMarkdownExtension = TiptapNode.create({
  name: 'preserved_markdown',
  group: 'block',
  content: 'text*',
  code: true,
  defining: true,
  marks: '',

  parseHTML() {
    return [{ tag: 'pre[data-preserved-markdown]', priority: 60, preserveWhitespace: 'full' }];
  },

  renderHTML() {
    return ['pre', { 'data-preserved-markdown': '', 'aria-label': 'Markdown source block' }, 0];
  },
});

const SourceIndexAndListAttrsExtension = Extension.create({
  name: 'kansoGlobalAttributes',
  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'blockquote',
          'horizontalRule',
          'codeBlock',
          'bulletList',
          'orderedList',
          'table',
          'callout',
          'footnote_definition',
          'mermaid_block',
          'math_block',
          'yaml_frontmatter',
          'preserved_markdown',
        ],
        attributes: {
          sourceIndex: {
            default: null,
            rendered: false,
          },
        },
      },
      {
        types: ['bulletList', 'orderedList'],
        attributes: {
          tight: {
            default: false,
            rendered: false,
            parseHTML: (element: HTMLElement) => element.hasAttribute('data-tight'),
          },
        },
      },
    ];
  },
});

const guardYamlFrontmatterBackspace: Command = ({ selection }) => {
  const { $from } = selection;
  return selection.empty
    && $from.parentOffset === 0
    && $from.pos === Selection.atStart($from.doc).from
    && $from.doc.firstChild?.type.name === 'yaml_frontmatter';
};

const KansoInteractionExtension = Extension.create({
  name: 'kansoInteraction',
  priority: 1000,

  addKeyboardShortcuts() {
    const run = (cmd: Command) => this.editor.commands.command(({ state, dispatch }) => cmd(state, dispatch));
    return {
      Backspace: () => run(chainCommands(
        guardYamlFrontmatterBackspace,
        unwrapEmptyCalloutOnBackspace,
        removeEmptyFootnoteOnBackspace,
      )),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: pasteVisualMarkdown,
          handleDOMEvents: {
            keydown(_view, event) {
              return event.target instanceof HTMLInputElement && event.target.type === 'checkbox';
            },
            change(view, event) {
              const checkbox = event.target;
              if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== 'checkbox') return false;
              const taskContent = checkbox.closest('[data-task]')?.querySelector('[data-task-content]');
              if (!taskContent) return false;

              const position = view.state.doc.resolve(view.posAtDOM(taskContent, 0));
              for (let depth = position.depth; depth > 0; depth--) {
                const item = position.node(depth);
                if (item.type.name !== 'listItem') continue;
                if (item.attrs.checked === null) return false;
                view.dispatch(view.state.tr.setNodeMarkup(position.before(depth), undefined, {
                  ...item.attrs,
                  checked: checkbox.checked,
                }));
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

export type VisualExtensionCallbacks = {
  noteId: string;
  onSlashMenuChange: (menu: SlashMenuState | null) => void;
  runSlashAction: (action: MarkdownAction) => Command;
  getWikiActions: () => WikiEditorActions;
  onWikiMenuChange: (menu: WikiMenu | null) => void;
  onWikiPreviewChange: (trigger: WikiPreviewTrigger | null) => void;
  onMathEditorChange: (session: MathEditorSession | null) => void;
  onFloatingToolbarChange: (toolbar: FloatingToolbarState | null) => void;
};

export function createVisualExtensions(callbacks?: VisualExtensionCallbacks) {
  const core = [
    KansoDocument,
    StarterKit.configure({
      document: false,
      codeBlock: false,
      listItem: false,
      trailingNode: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        markdownLinks: false,
        HTMLAttributes: { target: null, rel: null },
        isAllowedUri: (url) => safeHref(url),
      },
    }),
    KansoCodeBlock,
    KansoListItem,
    Highlight.configure({ multicolor: false }),
    Superscript.extend({ excludes: 'subscript' }),
    Subscript.extend({ excludes: 'superscript' }),
    Image.configure({ inline: true }),
    ManagedAttachmentExtension.configure({ noteId: callbacks?.noteId ?? '' }),
    KansoTable,
    TableRow,
    KansoTableCell,
    KansoTableHeader,
    YamlFrontmatterExtension,
    PreservedMarkdownExtension,
    CalloutExtension,
    FootnoteReferenceExtension,
    FootnoteDefinitionExtension,
    MermaidBlockExtension,
    InlineMathExtension,
    MathBlockExtension,
    WikiLinkExtension,
    SourceIndexAndListAttrsExtension,
  ];

  if (!callbacks) return core;

  return [
    ...core,
    CollapsibleSectionsExtension,
    visualSearchExtension,
    MathVisualExtension.configure({ onSessionChange: callbacks.onMathEditorChange }),
    WikiVisualExtension.configure({
      getActions: callbacks.getWikiActions,
      onMenuChange: callbacks.onWikiMenuChange,
      onPreviewChange: callbacks.onWikiPreviewChange,
    }),
    SlashCommandExtension.configure({
      onMenuChange: callbacks.onSlashMenuChange,
      runCommand: callbacks.runSlashAction,
    }),
    FloatingToolbarExtension.configure({ onToolbarChange: callbacks.onFloatingToolbarChange }),
    KansoInteractionExtension,
  ];
}

export const visualSchema = getSchema(createVisualExtensions());
