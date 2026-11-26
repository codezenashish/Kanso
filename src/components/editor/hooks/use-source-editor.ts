import { syntaxTree } from '@codemirror/language';
import { Annotation, EditorState, Prec, Transaction, type ChangeDesc, type ChangeSpec, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { findWikiReferenceOnLine, wikiInputContext, wikiSyntax } from '@/lib/wiki-markdown';
import { normalizeNewlines, restoreSourceChanges } from '../source-newlines';
import { sourceExtensions } from '../source/source-extensions';
import { formatSource } from '../source/source-formatting';
import type { WikiPreviewTrigger } from '../wiki-link-preview';
import {
  filterWikiNotes,
  matchWikiInput,
  wikiActiveDescendantId,
  wikiListId,
  wikiMenuOptionCount,
  type WikiMenu,
  type WikiSuggestion,
} from '../wiki-suggestions';
import type { WikiEditorActions } from '../wiki-visual';

const externalSourceSync = Annotation.define<boolean>();
const sourceLiteralNodes = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Frontmatter', 'DisplayMath', 'Link', 'URL']);

type SourceEditorOptions = {
  active: boolean;
  value: string;
  label?: string;
  wiki: WikiEditorActions;
  host: RefObject<HTMLDivElement | null>;
  onChange: (value: string) => void;
  mapAttachmentPosition?: (changes: ChangeDesc) => void;
  onSelection: (from: number, to: number) => void;
  publishWiki: (menu: WikiMenu | null) => void;
  publishWikiPreview: (trigger: WikiPreviewTrigger | null) => void;
};

function changedRange(current: string, next: string): ChangeSpec {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let to = current.length;
  let end = next.length;
  while (to > from && end > from && current[to - 1] === next[end - 1]) {
    to--;
    end--;
  }
  return { from, to, insert: next.slice(from, end) };
}

function isInLiteralSyntax(state: EditorState, pos: number) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; ) {
    if (sourceLiteralNodes.has(node.name)) return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

function findWikiAtSourcePos(state: EditorState, pos: number) {
  if (pos < 0 || pos > state.doc.length) return null;
  const line = state.doc.lineAt(pos);
  if (!line.text.includes('[[')) return null;
  const match = findWikiReferenceOnLine(line.text, pos - line.from);
  if (!match) return null;
  const from = line.from + match.start;
  const to = line.from + match.end;
  if (isInLiteralSyntax(state, from)) return null;
  return { ...match, from, to };
}

function buildSourcePreviewTrigger(
  view: EditorView,
  pos: number,
  source: 'hover' | 'focus',
): WikiPreviewTrigger | null {
  const link = findWikiAtSourcePos(view.state, pos);
  if (!link) return null;
  const startCoords = view.coordsAtPos(link.from);
  const endCoords = view.coordsAtPos(link.to);
  if (!startCoords || !endCoords) return null;
  const sameLine = Math.abs(startCoords.top - endCoords.top) < 8;
  return {
    target: link.target,
    alias: link.alias,
    left: startCoords.left,
    right: sameLine ? endCoords.right : Math.max(startCoords.right, endCoords.right),
    top: Math.min(startCoords.top, endCoords.top),
    bottom: Math.max(startCoords.bottom, endCoords.bottom),
    source,
    triggerKey: `source:${link.from}:${link.to}:${link.target}:${link.alias ?? ''}`,
    targetElement: source === 'focus' ? view.contentDOM : null,
  };
}

export function useSourceEditor(options: SourceEditorOptions) {
  const editor = useRef<EditorView>(null);
  const latest = useRef(options);
  const rawValue = useRef(options.value);

  useLayoutEffect(() => {
    latest.current = options;
  });

  useLayoutEffect(() => () => {
    editor.current?.destroy();
    editor.current = null;
  }, []);

  useLayoutEffect(() => {
    const host = options.host.current;
    if (!options.active || !host || editor.current) return;
    const { label, value } = latest.current;
    let frame = 0;
    let menu: WikiMenu | null = null;
    let signature = '';
    let dismissed = '';
    let selected = 0;
    let cachedContext: { doc: Text; offset: number; result: ReturnType<typeof wikiInputContext> } | undefined;
    let hoverPos: number | null = null;
    let lastEmittedPreview: WikiPreviewTrigger | null = null;
    let allowCompletedLinkMenu = false;

    function emitPreview(next: WikiPreviewTrigger | null) {
      if (
        next?.triggerKey === lastEmittedPreview?.triggerKey
        && next?.source === lastEmittedPreview?.source
        && next?.left === lastEmittedPreview?.left
        && next?.top === lastEmittedPreview?.top
      ) {
        return;
      }
      lastEmittedPreview = next;
      latest.current.publishWikiPreview(next);
    }

    function refreshPreview(view: EditorView) {
      if (label || !latest.current.active || menu) {
        emitPreview(null);
        return;
      }
      if (view.hasFocus) {
        const { from, to, head, empty } = view.state.selection.main;
        if (empty) {
          const focusTrigger = buildSourcePreviewTrigger(view, head, 'focus');
          if (focusTrigger) {
            emitPreview(focusTrigger);
            return;
          }
        } else {
          const link = findWikiAtSourcePos(view.state, from);
          if (link && to <= link.to) {
            const focusTrigger = buildSourcePreviewTrigger(view, from, 'focus');
            if (focusTrigger) {
              emitPreview(focusTrigger);
              return;
            }
          }
        }
      }
      if (hoverPos !== null) {
        emitPreview(buildSourcePreviewTrigger(view, hoverPos, 'hover'));
        return;
      }
      emitPreview(null);
    }

    function showMenu(view: EditorView, next: WikiMenu | null) {
      if (menu === null && next === null) return;
      menu = next;
      if (next) view.contentDOM.setAttribute('aria-controls', wikiListId);
      else view.contentDOM.removeAttribute('aria-controls');
      const activeDescendant = next ? wikiActiveDescendantId(next) : null;
      if (activeDescendant) view.contentDOM.setAttribute('aria-activedescendant', activeDescendant);
      else view.contentDOM.removeAttribute('aria-activedescendant');
      latest.current.publishWiki(next);
      refreshPreview(view);
    }

    function refreshWiki(view: EditorView) {
      const { selection, doc } = view.state;
      const { head, empty } = selection.main;
      if (label || !latest.current.active || !view.hasFocus || !empty) {
        showMenu(view, null);
        refreshPreview(view);
        return;
      }
      const line = doc.lineAt(head);
      const immediateSuffix = doc.sliceString(head, Math.min(line.to, head + 2));
      const completedLink = findWikiAtSourcePos(view.state, head);
      if (completedLink && head > completedLink.from && head < completedLink.to && !(allowCompletedLinkMenu && immediateSuffix.startsWith(']]'))) {
        dismissed = '';
        showMenu(view, null);
        refreshPreview(view);
        return;
      }
      const match = matchWikiInput(doc.sliceString(line.from, head), head, immediateSuffix);
      if (match && (cachedContext?.doc !== doc || cachedContext.offset !== match.from)) {
        cachedContext = { doc, offset: match.from, result: wikiInputContext(doc.toString(), match.from) };
      }
      const context = cachedContext?.result;
      if (!match || !context) {
        dismissed = '';
        showMenu(view, null);
        refreshPreview(view);
        return;
      }
      const nextSignature = `${match.from}:${match.query}:${match.alias ?? ''}`;
      if (dismissed === nextSignature) {
        showMenu(view, null);
        refreshPreview(view);
        return;
      }
      if (signature !== nextSignature) selected = 0;
      signature = nextSignature;
      const caret = view.coordsAtPos(head);
      if (!caret) {
        showMenu(view, null);
        return;
      }
      const currentWiki = latest.current.wiki;
      const results = filterWikiNotes(currentWiki.suggestions, match.query);
      const create = currentWiki.describeCreate(match.query);
      const optionCount = results.length + (create ? 1 : 0);
      selected = Math.min(selected, Math.max(0, optionCount - 1));

      function insertTarget(target: string) {
        if (!match || !context) return;
        const insert = wikiSyntax(target, match.alias?.trim() || null, context.inTable);
        view.focus();
        view.dispatch({
          changes: { from: match.from, to: match.to, insert },
          selection: { anchor: match.from + insert.length },
          userEvent: 'input.complete',
          scrollIntoView: true,
        });
        showMenu(view, null);
      }

      showMenu(view, {
        results,
        create,
        selected,
        left: caret.left,
        top: caret.top,
        bottom: caret.bottom,
        choose(note: WikiSuggestion) {
          if (view.state.doc !== doc || !view.state.selection.main.eq(selection.main)) {
            refreshWiki(view);
            return;
          }
          insertTarget(note.target);
        },
        chooseCreate() {
          if (!create) return;
          if (view.state.doc !== doc || !view.state.selection.main.eq(selection.main)) {
            refreshWiki(view);
            return;
          }
          const createdTarget = latest.current.wiki.create(create.target);
          if (!createdTarget) {
            dismissed = nextSignature;
            showMenu(view, null);
            return;
          }
          insertTarget(createdTarget);
        },
      });
    }

    function scheduleWiki(view: EditorView) {
      if (label || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (editor.current === view) refreshWiki(view);
      });
    }

    rawValue.current = value;
    editor.current = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: normalizeNewlines(value),
        extensions: [
          ...sourceExtensions(label),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.mapAttachmentPosition?.(update.changes);
            if (update.docChanged && update.transactions.some((transaction) => !transaction.annotation(externalSourceSync))) {
              const nextValue = restoreSourceChanges(rawValue.current, update.changes);
              rawValue.current = nextValue;
              latest.current.onChange(nextValue);
            }
            if (!label && (update.selectionSet || update.docChanged)) {
              const { from, to } = update.state.selection.main;
              latest.current.onSelection(from, to);
            }
            if (update.docChanged) {
              allowCompletedLinkMenu = true;
              scheduleWiki(update.view);
            } else if (update.selectionSet || ((menu || lastEmittedPreview) && update.geometryChanged)) {
              if (update.selectionSet) allowCompletedLinkMenu = false;
              scheduleWiki(update.view);
            }
          }),
          Prec.highest(EditorView.domEventHandlers({
            focus(_event, view) {
              allowCompletedLinkMenu = false;
              scheduleWiki(view);
            },
            blur(_event, view) {
              showMenu(view, null);
              refreshPreview(view);
            },
            scroll(_event, view) {
              if (menu || lastEmittedPreview) scheduleWiki(view);
            },
            mousemove(event, view) {
              if (label || !latest.current.active) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
              if (pos === hoverPos) return false;
              hoverPos = pos;
              refreshPreview(view);
              return false;
            },
            mouseleave(_event, view) {
              if (hoverPos === null) return false;
              hoverPos = null;
              refreshPreview(view);
              return false;
            },
            mousedown(event, view) {
              if (label || !(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
              if (pos === null) return false;
              const link = findWikiAtSourcePos(view.state, pos);
              if (!link) return false;
              event.preventDefault();
              emitPreview(null);
              latest.current.wiki.follow(link.target);
              return true;
            },
            keydown(event, view) {
              if (label || event.isComposing) return false;
              if (menu && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) refreshWiki(view);
              if (menu && event.key === 'Escape') {
                dismissed = signature;
                showMenu(view, null);
                return true;
              }
              const count = menu ? wikiMenuOptionCount(menu) : 0;
              if (menu && count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                selected = (selected + count + (event.key === 'ArrowDown' ? 1 : -1)) % count;
                refreshWiki(view);
                return true;
              }
              if (menu && count && event.key === 'Enter') {
                if (selected < menu.results.length) menu.choose(menu.results[selected]);
                else if (menu.create) menu.chooseCreate();
                return true;
              }
              if (!menu && event.altKey && event.key === 'Enter') {
                const { head, empty } = view.state.selection.main;
                if (empty) {
                  const link = findWikiAtSourcePos(view.state, head);
                  if (link) {
                    event.preventDefault();
                    emitPreview(null);
                    latest.current.wiki.follow(link.target);
                    return true;
                  }
                }
              }
              const key = event.key.toLowerCase();
              if (!(event.metaKey || event.ctrlKey) || event.altKey || (key !== 'b' && key !== 'i')) return false;
              formatSource(view, { type: key === 'b' ? 'bold' : 'italic' });
              return true;
            },
          })),
        ],
      }),
    });
  }, [options.active, options.host]);

  useLayoutEffect(() => {
    const source = editor.current;
    if (!options.active || !source) return;
    if (rawValue.current === options.value) return;
    rawValue.current = options.value;
    const current = source.state.doc.toString();
    const next = normalizeNewlines(options.value);
    if (current !== next) {
      source.dispatch({
        changes: changedRange(current, next),
        annotations: [Transaction.addToHistory.of(false), externalSourceSync.of(true)],
      });
    }
  }, [options.active, options.value]);

  useLayoutEffect(() => {
    if (options.active) editor.current?.requestMeasure();
  }, [options.active]);

  return editor;
}
