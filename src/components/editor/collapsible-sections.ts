import { Extension } from '@tiptap/core';
import type { Node as EditorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

type CollapseMeta = { togglePos: number };

const collapsibleSectionsKey = new PluginKey<Set<number>>('collapsibleSections');

function findSectionRangeEnd(doc: EditorNode, headingPos: number, headingNode: EditorNode): number {
  const level = Number(headingNode.attrs.level ?? 1);
  let rangeEnd = doc.content.size;
  let reachedCurrent = false;

  doc.forEach((child, offset) => {
    if (offset === headingPos) {
      reachedCurrent = true;
      return;
    }
    if (!reachedCurrent || rangeEnd !== doc.content.size) return;
    if (child.type.name === 'heading' && Number(child.attrs.level ?? 1) <= level) {
      rangeEnd = offset;
    }
  });

  return rangeEnd;
}

function createChevronButton(view: EditorView, headingPos: number, collapsed: boolean, sectionEnd: number): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'editor-collapse-toggle';
  button.contentEditable = 'false';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
  button.title = collapsed ? 'Expand section' : 'Collapse section';
  button.setAttribute('data-collapsed', String(collapsed));

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
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  svg.appendChild(path);
  button.appendChild(svg);

  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const { state } = view;
    const node = state.doc.nodeAt(headingPos);
    if (!node || node.type.name !== 'heading') return;

    const tr = state.tr.setMeta(collapsibleSectionsKey, { togglePos: headingPos } satisfies CollapseMeta);
    const bodyStart = headingPos + node.nodeSize;
    if (!collapsed && state.selection.from >= bodyStart && state.selection.from < sectionEnd) {
      tr.setSelection(TextSelection.near(state.doc.resolve(headingPos + 1)));
    }
    view.dispatch(tr);
    view.focus();
  });

  return button;
}

function buildCollapseDecorations(doc: EditorNode, collapsedSet: Set<number>): DecorationSet {
  const decorations: Decoration[] = [];
  let collapsedUntilLevel: number | null = null;

  doc.forEach((node, pos) => {
    if (node.type.name === 'heading') {
      const level = Number(node.attrs.level ?? 1);
      if (collapsedUntilLevel !== null && level <= collapsedUntilLevel) {
        collapsedUntilLevel = null;
      }

      if (collapsedUntilLevel !== null) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-collapsed-section' }));
        return;
      }

      const isCollapsed = collapsedSet.has(pos);
      const sectionEnd = findSectionRangeEnd(doc, pos, node);
      const hasContentAfter = pos + node.nodeSize < sectionEnd;

      if (hasContentAfter || isCollapsed) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: isCollapsed ? 'is-heading-collapsible is-heading-collapsed' : 'is-heading-collapsible',
          }),
        );
        decorations.push(
          Decoration.widget(
            pos + 1,
            (view) => createChevronButton(view, pos, isCollapsed, sectionEnd),
            { side: -1, ignoreSelection: true, key: `collapse-${pos}-${isCollapsed ? '1' : '0'}` },
          ),
        );
      }

      if (isCollapsed) {
        collapsedUntilLevel = level;
      }
      return;
    }

    if (collapsedUntilLevel !== null) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-collapsed-section' }));
    }
  });

  return DecorationSet.create(doc, decorations);
}

export function collapsibleSectionsPlugin() {
  return new Plugin<Set<number>>({
    key: collapsibleSectionsKey,
    state: {
      init: () => new Set<number>(),
      apply(tr, previous, _oldState, newState) {
        const next = new Set<number>();
        for (const oldPos of previous) {
          const mapped = tr.mapping.mapResult(oldPos, -1);
          if (mapped.deleted) continue;
          const candidate = newState.doc.nodeAt(mapped.pos);
          if (candidate?.type.name === 'heading') {
            next.add(mapped.pos);
          }
        }

        const reveal = tr.getMeta('kansoRevealSection') as number | undefined;
        if (reveal !== undefined) {
          for (const position of next) {
            const heading = newState.doc.nodeAt(position);
            if (heading && reveal >= position + heading.nodeSize && reveal < findSectionRangeEnd(newState.doc, position, heading)) {
              next.delete(position);
            }
          }
        }

        const meta = tr.getMeta(collapsibleSectionsKey) as CollapseMeta | undefined;
        if (meta) {
          if (next.has(meta.togglePos)) next.delete(meta.togglePos);
          else if (newState.doc.nodeAt(meta.togglePos)?.type.name === 'heading') next.add(meta.togglePos);
          return next;
        }

        if (next.size && (tr.selectionSet || tr.docChanged)) {
          const { from, to } = newState.selection;
          for (const collapsedPos of [...next]) {
            const node = newState.doc.nodeAt(collapsedPos);
            if (!node || node.type.name !== 'heading') {
              next.delete(collapsedPos);
              continue;
            }
            const bodyStart = collapsedPos + node.nodeSize;
            const rangeEnd = findSectionRangeEnd(newState.doc, collapsedPos, node);
            if ((from >= bodyStart && from < rangeEnd) || (to > bodyStart && to <= rangeEnd)) {
              next.delete(collapsedPos);
            }
          }
        }

        return next;
      },
    },
    props: {
      decorations(state) {
        const collapsed = collapsibleSectionsKey.getState(state);
        if (!collapsed) return DecorationSet.empty;
        return buildCollapseDecorations(state.doc, collapsed);
      },
    },
  });
}

export const CollapsibleSectionsExtension = Extension.create({
  name: 'collapsibleSections',
  addProseMirrorPlugins() {
    return [collapsibleSectionsPlugin()];
  },
});

export function revealSectionAt(view: EditorView, position: number) {
  if (collapsibleSectionsKey.getState(view.state)?.size) {
    view.dispatch(view.state.tr.setMeta('kansoRevealSection', position));
  }
}
