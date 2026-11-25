import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { renderLatex } from './math-render';
import type { MathEditorSession, MathMode } from './math-visual';

type MathEditorPopoverProps = {
  session: MathEditorSession;
};

function unwrapOuterDelimiters(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length >= 4 && trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    const inner = trimmed.slice(2, -2).trim();
    if (inner && !inner.includes('$$')) return inner;
  }
  if (trimmed.length >= 2 && trimmed.startsWith('$') && trimmed.endsWith('$') && !trimmed.startsWith('$$')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner && !/(?:^|[^\\])\$/.test(inner)) return inner;
  }
  return null;
}

function MathEditorContent({ session }: MathEditorPopoverProps) {
  const [latex, setLatex] = useState(session.initialLatex);
  const [mode, setMode] = useState<MathMode>(session.mode);
  const [placement, setPlacement] = useState<{ left: number; top?: number; bottom?: number }>({
    left: session.anchorRect.left,
    top: session.anchorRect.bottom + 6,
  });

  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const latestRef = useRef({ latex, mode, session });
  latestRef.current = { latex, mode, session };

  const preview = useMemo(() => renderLatex(latex, mode === 'block'), [latex, mode]);
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const width = popover?.offsetWidth || 384;
    const height = popover?.offsetHeight || 240;
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - session.anchorRect.bottom - margin;
    const spaceAbove = session.anchorRect.top - margin;
    const placeAbove = spaceBelow < height && spaceAbove > spaceBelow;
    const left = Math.max(margin, Math.min(session.anchorRect.left, viewportWidth - width - margin));
    if (placeAbove) {
      setPlacement({ left, bottom: viewportHeight - session.anchorRect.top + 6 });
    } else {
      setPlacement({ left, top: Math.min(session.anchorRect.bottom + 6, Math.max(margin, viewportHeight - height - margin)) });
    }
  }, [session.anchorRect, preview.html, preview.error, mode]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      const { latex: currentLatex, mode: currentMode, session: active } = latestRef.current;
      if (active.isNew && !currentLatex.trim()) {
        active.cancel();
      } else if (currentLatex !== active.initialLatex || currentMode !== active.mode) {
        active.apply(currentLatex, currentMode);
      } else {
        active.cancel();
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      session.cancel();
      return;
    }
    const submitShortcut = (event.metaKey || event.ctrlKey) && event.key === 'Enter';
    const inlineEnter = mode === 'inline' && event.key === 'Enter' && !event.shiftKey && !event.altKey;
    if (submitShortcut || inlineEnter) {
      event.preventDefault();
      event.stopPropagation();
      session.apply(latex, mode);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget;
    const replacesAll = input.selectionStart === 0 && input.selectionEnd === input.value.length;
    if (input.value && !replacesAll) return;
    const raw = event.clipboardData.getData('text/plain');
    const unwrapped = unwrapOuterDelimiters(raw);
    if (!unwrapped) return;
    event.preventDefault();
    setLatex(unwrapped);
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={mode === 'block' ? 'Edit block equation' : 'Edit inline math'}
      className="fixed z-40 flex w-[min(24rem,calc(100dvw-1rem))] flex-col gap-2.5 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100"
      style={{
        left: `${placement.left}px`,
        top: placement.top !== undefined ? `${placement.top}px` : undefined,
        bottom: placement.bottom !== undefined ? `${placement.bottom}px` : undefined,
      }}
    >
      <div className="flex items-center justify-between gap-2">
        {session.isNew ? (
          <div role="group" aria-label="Math display mode" className="inline-flex rounded-lg border border-border bg-background/70 p-0.5 text-xs">
            <button
              type="button"
              aria-pressed={mode === 'inline'}
              className={cn(
                'cursor-pointer rounded-md px-2 py-0.5 font-medium motion-safe:transition-colors',
                mode === 'inline' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setMode('inline')}
            >
              Inline $
            </button>
            <button
              type="button"
              aria-pressed={mode === 'block'}
              className={cn(
                'cursor-pointer rounded-md px-2 py-0.5 font-medium motion-safe:transition-colors',
                mode === 'block' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setMode('block')}
            >
              Block $$
            </button>
          </div>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">
            {mode === 'block' ? 'Block equation ($$…$$)' : 'Inline math ($…$)'}
          </span>
        )}
        {session.remove && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Delete equation"
            aria-label="Delete equation"
            className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
            onClick={() => session.remove?.()}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        )}
      </div>

      <div
        aria-live="polite"
        className={cn(
          'flex min-h-12 max-h-36 items-center justify-center overflow-auto rounded-lg border px-3 py-2 text-foreground',
          preview.error ? 'border-destructive/40 bg-destructive/10' : 'border-border/70 bg-background/60',
        )}
      >
        {!latex.trim() ? (
          <span className="text-xs text-muted-foreground italic">Preview appears here</span>
        ) : preview.error ? (
          <p className="w-full font-mono text-xs leading-snug break-words text-destructive">{preview.error}</p>
        ) : (
          <div
            className="max-w-full overflow-x-auto py-0.5 [&_.katex-display]:my-0"
            dangerouslySetInnerHTML={{ __html: preview.html }}
          />
        )}
      </div>

      <textarea
        ref={inputRef}
        aria-label="LaTeX expression"
        rows={mode === 'block' ? 3 : 2}
        spellCheck={false}
        placeholder={mode === 'block' ? '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' : 'E = mc^2'}
        className="w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-sm leading-snug text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        value={latex}
        onChange={(event) => setLatex(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] text-muted-foreground">
          {mode === 'inline' ? 'Enter to apply · Esc to cancel' : `${isMac ? '⌘' : 'Ctrl+'}Enter to apply · Esc to cancel`}
        </span>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => session.cancel()}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => session.apply(latex, mode)}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

export function MathEditorPopover({ session }: { session: MathEditorSession | null }) {
  if (!session) return null;
  const sessionKey = `${session.isNew}:${session.mode}:${session.initialLatex}:${session.anchorRect.left}:${session.anchorRect.top}`;
  return createPortal(<MathEditorContent key={sessionKey} session={session} />, document.body);
}
