import { useState } from 'react';
import {
  Bold, Code, Italic, Link as LinkIcon, List, ListOrdered, Minus, Quote, Redo2,
  Strikethrough, Underline, Undo2, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { safeHref } from '../visual-markdown';

export type MarkdownAction =
  | { type: 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'strike' | 'inlineCode' | 'bulletList' | 'orderedList' | 'quote' | 'codeBlock' | 'divider' }
  | { type: 'heading'; level: number }
  | { type: 'link'; href: string };

type MarkdownToolbarProps = {
  onAction: (action: MarkdownAction) => void;
  onReturnFocus: () => void;
};

export function MarkdownToolbar({ onAction, onReturnFocus }: MarkdownToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const target = linkTarget.trim().replace(/ /g, '%20');
  const invalidTarget = Boolean(target && !safeHref(target));

  function tool(label: string, Icon: LucideIcon, onClick: () => void) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground"
        title={label}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        <Icon />
      </Button>
    );
  }

  return (
    <div className="mb-3 shrink-0 border-b border-border bg-background">
      <div className="flex min-h-11 items-center gap-0.5 overflow-x-auto py-1 [&::-webkit-scrollbar]:hidden" role="toolbar" aria-label="Markdown formatting">
        {tool('Undo', Undo2, () => onAction({ type: 'undo' }))}
        {tool('Redo', Redo2, () => onAction({ type: 'redo' }))}
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        {tool('Bold', Bold, () => onAction({ type: 'bold' }))}
        {tool('Italic', Italic, () => onAction({ type: 'italic' }))}
        {tool('Underline', Underline, () => onAction({ type: 'underline' }))}
        {tool('Strikethrough', Strikethrough, () => onAction({ type: 'strike' }))}
        {tool('Inline code', Code, () => onAction({ type: 'inlineCode' }))}
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        <select
          aria-label="Heading"
          className="h-8 max-w-28 shrink-0 rounded-md bg-background px-1.5 text-sm text-foreground hover:bg-accent"
          onChange={(event) => {
            onAction({ type: 'heading', level: Number(event.target.value) });
            event.target.value = '';
          }}
          defaultValue=""
        >
          <option value="" disabled>Text</option>
          <option value="0">Paragraph</option>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <option key={level} value={level}>Heading {level}</option>
          ))}
        </select>
        {tool('Bulleted list', List, () => onAction({ type: 'bulletList' }))}
        {tool('Numbered list', ListOrdered, () => onAction({ type: 'orderedList' }))}
        {tool('Quote', Quote, () => onAction({ type: 'quote' }))}
        {tool('Code block', Code, () => onAction({ type: 'codeBlock' }))}
        {tool('Link', LinkIcon, () => setLinkOpen(true))}
        {tool('Divider', Minus, () => onAction({ type: 'divider' }))}
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
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
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
    </div>
  );
}
