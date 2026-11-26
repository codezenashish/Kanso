import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Bold, BookmarkPlus, Code, Highlighter, Info, Italic, Lightbulb,
  Link as LinkIcon, List, ListOrdered, MessageSquareWarning, Minus, MoreHorizontal,
  Paperclip, Quote, Redo2, ShieldAlert, Sigma, SquareFunction, Strikethrough, Subscript,
  Superscript, Underline, Undo2, Workflow, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import WarmTooltip, { WarmTooltipGroup } from '@/components/ui/warm-tooltip';
import { cn } from '@/lib/utils';
import type { CalloutKind } from '../callout-visual';
import { editorLayouts, type EditorLayout } from '../editor-layout';
import { parseSafeLinkInput } from '../visual-markdown';
import { sameFormatting, type FormattingState, type FormatToggle } from './formatting-state';

export type MarkdownAction =
  | {
      type:
        | 'undo'
        | 'redo'
        | 'bold'
        | 'italic'
        | 'underline'
        | 'strike'
        | 'highlight'
        | 'superscript'
        | 'subscript'
        | 'inlineCode'
        | 'inlineMath'
        | 'mathBlock'
        | 'bulletList'
        | 'orderedList'
        | 'quote'
        | 'codeBlock'
        | 'divider'
        | 'footnote'
        | 'mermaid';
    }
  | { type: 'callout'; kind: CalloutKind }
  | { type: 'heading'; level: number }
  | { type: 'link'; href: string };

type MarkdownToolbarProps = {
  formats: FormattingState;
  layout: EditorLayout;
  onChangeLayout: (layout: EditorLayout) => void;
  onAction: (action: MarkdownAction) => void;
  onReturnFocus: () => void;
  onAttachFile: () => void;
  attachingFile: boolean;
};

const calloutItems: { kind: CalloutKind; label: string; Icon: LucideIcon }[] = [
  { kind: 'note', label: 'Note callout', Icon: Info },
  { kind: 'tip', label: 'Tip callout', Icon: Lightbulb },
  { kind: 'important', label: 'Important callout', Icon: MessageSquareWarning },
  { kind: 'warning', label: 'Warning callout', Icon: AlertTriangle },
  { kind: 'caution', label: 'Caution callout', Icon: ShieldAlert },
];

export const MarkdownToolbar = memo(function MarkdownToolbar({ formats, layout, onChangeLayout, onAction, onReturnFocus, onAttachFile, attachingFile }: MarkdownToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<{ left: number; top: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const { href: target, invalid: invalidTarget } = parseSafeLinkInput(linkTarget);

  useLayoutEffect(() => {
    if (!moreOpen || !moreButtonRef.current) {
      setMoreAnchor(null);
      return;
    }
    const button = moreButtonRef.current;
    const rect = button.getBoundingClientRect();
    const width = 228;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const measuredHeight = moreMenuRef.current?.getBoundingClientRect().height ?? 320;
    const fitsBelow = window.innerHeight - rect.bottom >= measuredHeight + 12;
    setMoreAnchor({ left, top: fitsBelow ? rect.bottom + 6 : Math.max(8, rect.top - measuredHeight - 6) });
  }, [moreOpen]);

  useLayoutEffect(() => {
    if (!moreOpen) return;
    const reposition = () => {
      const button = moreButtonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const menu = moreMenuRef.current;
      const width = menu?.getBoundingClientRect().width ?? 228;
      const height = menu?.getBoundingClientRect().height ?? 320;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const fitsBelow = window.innerHeight - rect.bottom >= height + 12;
      setMoreAnchor({ left, top: fitsBelow ? rect.bottom + 6 : Math.max(8, rect.top - height - 6) });
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [moreOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const targetNode = event.target;
      if (!(targetNode instanceof Node)) return;
      if (moreMenuRef.current?.contains(targetNode) || moreButtonRef.current?.contains(targetNode)) return;
      setMoreOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setMoreOpen(false);
      onReturnFocus();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreOpen, onReturnFocus]);

  function runAdvancedAction(action: MarkdownAction) {
    setMoreOpen(false);
    onAction(action);
  }

  function tool(label: string, Icon: LucideIcon, onClick: () => void, toggle?: FormatToggle | 'link') {
    const pressed = toggle === 'link' ? undefined : toggle ? formats.toggles[toggle] ?? false : undefined;
    const active = toggle === 'link' ? formats.link || linkOpen : Boolean(pressed);
    return (
      <WarmTooltip content={label} side="bottom" className="shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className={cn('shrink-0 focus-visible:ring-inset', active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
          aria-pressed={pressed}
          aria-expanded={toggle === 'link' ? linkOpen : undefined}
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
        >
          <Icon aria-hidden="true" />
        </Button>
      </WarmTooltip>
    );
  }

  const advancedActive = Boolean(formats.toggles.superscript || formats.toggles.subscript || formats.toggles.callout || moreOpen);

  return (
    <div className="mb-3 shrink-0 border-b border-border">
      <div className="flex items-center gap-2">
        <div className="flex h-11 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="toolbar" aria-label="Markdown formatting">
          <WarmTooltipGroup>
            {tool('Undo', Undo2, () => onAction({ type: 'undo' }))}
            {tool('Redo', Redo2, () => onAction({ type: 'redo' }))}
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            {tool('Bold', Bold, () => onAction({ type: 'bold' }), 'bold')}
            {tool('Italic', Italic, () => onAction({ type: 'italic' }), 'italic')}
            {tool('Underline', Underline, () => onAction({ type: 'underline' }), 'underline')}
            {tool('Strikethrough', Strikethrough, () => onAction({ type: 'strike' }), 'strike')}
            {tool('Highlight', Highlighter, () => onAction({ type: 'highlight' }), 'highlight')}
            {tool('Inline code', Code, () => onAction({ type: 'inlineCode' }), 'inlineCode')}
            {tool('Math equation', Sigma, () => onAction({ type: 'inlineMath' }), 'inlineMath')}
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            <Select aria-label="Heading" className="h-8 w-32 shrink-0 text-xs" value={String(formats.heading)}
              options={[{ value: '', label: 'Text' }, { value: '0', label: 'Paragraph' }, ...[1, 2, 3, 4, 5, 6].map((level) => ({ value: String(level), label: `Heading ${level}` }))]}
              onValueChange={(value) => { if (value !== '') onAction({ type: 'heading', level: Number(value) }); }} />
            {tool('Bulleted list', List, () => onAction({ type: 'bulletList' }), 'bulletList')}
            {tool('Numbered list', ListOrdered, () => onAction({ type: 'orderedList' }), 'orderedList')}
            {tool('Quote', Quote, () => onAction({ type: 'quote' }), 'quote')}
            {tool('Code block', Code, () => onAction({ type: 'codeBlock' }), 'codeBlock')}
            {tool('Link', LinkIcon, () => setLinkOpen(true), 'link')}
            {tool('Divider', Minus, () => onAction({ type: 'divider' }))}
            <WarmTooltip content="More formatting & blocks" side="bottom" disabled={moreOpen} className="shrink-0">
              <Button
                ref={moreButtonRef}
                variant="ghost"
                size="icon"
                className={cn('shrink-0 focus-visible:ring-inset', advancedActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                aria-label="More formatting & blocks"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setMoreOpen((open) => !open)}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </WarmTooltip>
          </WarmTooltipGroup>
        </div>
        <Button variant="ghost" size="icon" title="Attach file" aria-label="Attach file"
          disabled={attachingFile} onMouseDown={(event) => event.preventDefault()} onClick={() => onAttachFile()}>
          <Paperclip aria-hidden="true" />
        </Button>
        <Select aria-label="Editor layout" className="h-8 w-36 shrink-0 text-xs" value={layout}
          options={editorLayouts.map(({ id, label }) => ({ value: id, label }))}
          onValueChange={(value) => { const selected = editorLayouts.find(({ id }) => id === value); if (selected) onChangeLayout(selected.id); }} />
      </div>
      {linkOpen && (
        <form
          className="flex flex-wrap items-center gap-1 pb-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!target || invalidTarget) return;
            onAction({ type: 'link', href: target });
            setLinkOpen(false);
            setLinkTarget('');
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            setLinkOpen(false);
            onReturnFocus();
          }}
        >
          <input
            autoFocus
            required
            aria-label="Link address"
            aria-invalid={invalidTarget}
            placeholder="Link address"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            value={linkTarget}
            onChange={(event) => setLinkTarget(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!target || invalidTarget}>Apply</Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setLinkOpen(false);
              onReturnFocus();
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {moreOpen && moreAnchor && createPortal(
        <div
          ref={moreMenuRef}
          role="menu"
          aria-label="More formatting and blocks"
          className="fixed z-40 flex w-57 flex-col gap-0.5 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100"
          style={{ left: `${moreAnchor.left}px`, top: `${moreAnchor.top}px` }}
        >
          <div className="px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground">Text</div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={Boolean(formats.toggles.superscript)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
              formats.toggles.superscript && 'bg-accent/70 text-accent-foreground',
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runAdvancedAction({ type: 'superscript' })}
          >
            <Superscript aria-hidden="true" className="size-4 text-muted-foreground" />
            <span>Superscript</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={Boolean(formats.toggles.subscript)}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
              formats.toggles.subscript && 'bg-accent/70 text-accent-foreground',
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runAdvancedAction({ type: 'subscript' })}
          >
            <Subscript aria-hidden="true" className="size-4 text-muted-foreground" />
            <span>Subscript</span>
          </button>

          <span aria-hidden="true" className="my-1 h-px bg-border" />
          <div className="px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground">Insert</div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runAdvancedAction({ type: 'mathBlock' })}
          >
            <SquareFunction aria-hidden="true" className="size-4 text-muted-foreground" />
            <span>Block equation</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runAdvancedAction({ type: 'mermaid' })}
          >
            <Workflow aria-hidden="true" className="size-4 text-muted-foreground" />
            <span>Mermaid diagram</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runAdvancedAction({ type: 'footnote' })}
          >
            <BookmarkPlus aria-hidden="true" className="size-4 text-muted-foreground" />
            <span>Footnote</span>
          </button>

          <span aria-hidden="true" className="my-1 h-px bg-border" />
          <div className="px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground">Callout</div>
          {calloutItems.map(({ kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runAdvancedAction({ type: 'callout', kind })}
            >
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              <span>{label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}, (previous, next) =>
  previous.layout === next.layout
  && previous.onChangeLayout === next.onChangeLayout
  && previous.onAction === next.onAction
  && previous.onReturnFocus === next.onReturnFocus
  && previous.onAttachFile === next.onAttachFile
  && previous.attachingFile === next.attachingFile
  && sameFormatting(previous.formats, next.formats),
);
