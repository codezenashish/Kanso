import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bold, Code, Highlighter, Italic, Link as LinkIcon, Sigma, Strikethrough,
  Subscript, Superscript, Underline, type LucideIcon,
} from 'lucide-react';
import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Button } from '@/components/ui/button';
import WarmTooltip, { WarmTooltipGroup } from '@/components/ui/warm-tooltip';
import { cn } from '@/lib/utils';
import type { FormattingState, FormatToggle } from './toolbar/formatting-state';
import type { MarkdownAction } from './toolbar/markdown-toolbar';
import { parseSafeLinkInput } from './visual-markdown';

export type FloatingToolbarState = {
  left: number;
  top: number;
  bottom: number;
  above: boolean;
};

const toolbarId = 'editor-floating-toolbar';

function selectionRect(view: EditorView): FloatingToolbarState | null {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || selection.empty || view.composing) return null;
  if (selection.$from.parent.type.spec.code) return null;

  const doc = view.dom.ownerDocument;
  const toolbarFocused = doc.getElementById(toolbarId)?.contains(doc.activeElement) ?? false;
  if (!view.hasFocus() && !toolbarFocused) return null;

  const start = view.coordsAtPos(selection.from);
  const end = view.coordsAtPos(selection.to);
  const sameLine = Math.abs(start.top - end.top) < 8;
  const left = sameLine ? (start.left + end.right) / 2 : start.left + 80;
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  const above = top > 56;
  return { left, top, bottom, above };
}

export function floatingToolbarPlugin(publish: (toolbar: FloatingToolbarState | null) => void) {
  function sync(view: EditorView) {
    if (view.isDestroyed) return;
    publish(selectionRect(view));
  }

  function scheduleSync(view: EditorView) {
    queueMicrotask(() => sync(view));
  }

  return new Plugin({
    props: {
      handleDOMEvents: {
        focus(view) { scheduleSync(view); return false; },
        blur(view) { scheduleSync(view); return false; },
      },
    },
    view(view) {
      const browser = view.dom.ownerDocument.defaultView;
      const updatePosition = () => {
        if (!view.state.selection.empty) sync(view);
      };
      browser?.addEventListener('resize', updatePosition);
      browser?.addEventListener('scroll', updatePosition, true);
      return {
        update: sync,
        destroy() {
          browser?.removeEventListener('resize', updatePosition);
          browser?.removeEventListener('scroll', updatePosition, true);
          publish(null);
        },
      };
    },
  });
}

export const FloatingToolbarExtension = Extension.create<{
  onToolbarChange: (toolbar: FloatingToolbarState | null) => void;
}>({
  name: 'floatingToolbar',
  addOptions() {
    return {
      onToolbarChange: () => {},
    };
  },
  addProseMirrorPlugins() {
    return [floatingToolbarPlugin(this.options.onToolbarChange)];
  },
});

type FloatingToolbarProps = {
  state: FloatingToolbarState | null;
  formats: FormattingState;
  onAction: (action: MarkdownAction) => void;
  onReturnFocus: () => void;
};

export function FloatingToolbar({ state, formats, onAction, onReturnFocus }: FloatingToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const [clampedLeft, setClampedLeft] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!state) {
      setLinkOpen(false);
      setLinkTarget('');
      setClampedLeft(null);
      return;
    }
    const element = containerRef.current;
    const width = element?.offsetWidth || 320;
    const margin = 8;
    const half = width / 2;
    const clamped = Math.max(margin + half, Math.min(state.left, window.innerWidth - margin - half));
    setClampedLeft(clamped);
  }, [state, linkOpen]);

  if (!state) return null;

  const { href: target, invalid: invalidTarget } = parseSafeLinkInput(linkTarget);

  function tool(label: string, Icon: LucideIcon, action: MarkdownAction, toggle?: FormatToggle) {
    const pressed = toggle ? Boolean(formats.toggles[toggle]) : false;
    return (
      <WarmTooltip content={label} className="shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            'size-7 shrink-0 rounded-md',
            pressed ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          aria-pressed={toggle ? pressed : undefined}
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAction(action)}
        >
          <Icon aria-hidden="true" className="size-3.5" />
        </Button>
      </WarmTooltip>
    );
  }

  return createPortal(
    <div
      id={toolbarId}
      ref={containerRef}
      role="toolbar"
      aria-label="Selection formatting"
      className="fixed z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100"
      style={{
        left: `${clampedLeft ?? state.left}px`,
        top: state.above ? `${Math.max(8, state.top - 46)}px` : `${state.bottom + 8}px`,
      }}
    >
      {linkOpen ? (
        <form
          className="flex items-center gap-1 px-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!target || invalidTarget) return;
            onAction({ type: 'link', href: target });
            setLinkOpen(false);
            setLinkTarget('');
            onReturnFocus();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setLinkOpen(false);
            onReturnFocus();
          }}
        >
          <input
            autoFocus
            required
            aria-label="Link address"
            aria-invalid={invalidTarget}
            placeholder="https://..."
            className="h-7 w-44 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            value={linkTarget}
            onChange={(event) => setLinkTarget(event.target.value)}
          />
          <Button type="submit" size="xs" disabled={!target || invalidTarget}>Apply</Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setLinkOpen(false);
              onReturnFocus();
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <WarmTooltipGroup>
          {tool('Bold', Bold, { type: 'bold' }, 'bold')}
          {tool('Italic', Italic, { type: 'italic' }, 'italic')}
          {tool('Underline', Underline, { type: 'underline' }, 'underline')}
          {tool('Strikethrough', Strikethrough, { type: 'strike' }, 'strike')}
          {tool('Highlight', Highlighter, { type: 'highlight' }, 'highlight')}
          {tool('Inline code', Code, { type: 'inlineCode' }, 'inlineCode')}
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          {tool('Superscript', Superscript, { type: 'superscript' }, 'superscript')}
          {tool('Subscript', Subscript, { type: 'subscript' }, 'subscript')}
          {tool('Inline math', Sigma, { type: 'inlineMath' }, 'inlineMath')}
          <WarmTooltip content="Link" className="shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={cn(
                'size-7 shrink-0 rounded-md',
                formats.link ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              aria-label="Link"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setLinkOpen(true)}
            >
              <LinkIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </WarmTooltip>
        </WarmTooltipGroup>
      )}
    </div>,
    document.body,
  );
}
