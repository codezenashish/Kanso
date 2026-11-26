import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, FileQuestion, FileText, FolderTree } from 'lucide-react';
import { cn } from '@/lib/utils';

export const wikiPreviewId = 'wiki-link-preview';
const previewDelayMs = 350;
const hoverCloseGraceMs = 80;

export type WikiLinkPreviewInfo = {
  target: string;
  alias: string | null;
  status: 'resolved' | 'inactive' | 'ambiguous' | 'missing';
  title: string;
  path: string | null;
  snippet: string;
  canCreate: boolean;
  matches?: string[];
};

export type WikiPreviewTrigger = {
  target: string;
  alias: string | null;
  left: number;
  right: number;
  top: number;
  bottom: number;
  source: 'hover' | 'focus';
  triggerKey: string;
  targetElement?: HTMLElement | null;
};

type WikiLinkPreviewProps = {
  trigger: WikiPreviewTrigger | null;
  suppressed?: boolean;
  resolvePreview: (target: string, alias?: string | null) => WikiLinkPreviewInfo;
};

function addDescribedBy(element: HTMLElement, id: string) {
  const existing = element.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
  if (!existing.includes(id)) {
    element.setAttribute('aria-describedby', [...existing, id].join(' '));
  }
}

function removeDescribedBy(element: HTMLElement, id: string) {
  const remaining = (element.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [])
    .filter((item) => item !== id);
  if (remaining.length) element.setAttribute('aria-describedby', remaining.join(' '));
  else element.removeAttribute('aria-describedby');
}

export function WikiLinkPreview({ trigger, suppressed = false, resolvePreview }: WikiLinkPreviewProps) {
  const activeTrigger = suppressed ? null : trigger;
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [retainedTrigger, setRetainedTrigger] = useState<WikiPreviewTrigger | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardLeft, setCardLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!activeTrigger) {
      setDismissedKey(null);
      if (!retainedTrigger) return;
      if (suppressed || retainedTrigger.source === 'focus') {
        setVisibleKey(null);
        setRetainedTrigger(null);
        return;
      }
      const timer = window.setTimeout(() => {
        setVisibleKey(null);
        setRetainedTrigger(null);
      }, hoverCloseGraceMs);
      return () => window.clearTimeout(timer);
    }

    if (dismissedKey === activeTrigger.triggerKey) {
      setVisibleKey(null);
      setRetainedTrigger(null);
      return;
    }

    setRetainedTrigger(activeTrigger);
    if (visibleKey === activeTrigger.triggerKey) return;

    const timer = window.setTimeout(() => {
      setVisibleKey(activeTrigger.triggerKey);
    }, previewDelayMs);
    return () => window.clearTimeout(timer);
  }, [activeTrigger, dismissedKey, retainedTrigger, suppressed, visibleKey]);

  const shownTrigger = activeTrigger ?? retainedTrigger;
  const isVisible = Boolean(
    shownTrigger
    && visibleKey === shownTrigger.triggerKey
    && dismissedKey !== shownTrigger.triggerKey,
  );

  useEffect(() => {
    if (!isVisible || !shownTrigger) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setDismissedKey(shownTrigger!.triggerKey);
      setVisibleKey(null);
      setRetainedTrigger(null);
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isVisible, shownTrigger]);

  useEffect(() => {
    const element = isVisible && shownTrigger?.source === 'focus' ? shownTrigger.targetElement : null;
    if (!element || !element.isConnected) return;
    addDescribedBy(element, wikiPreviewId);
    return () => removeDescribedBy(element, wikiPreviewId);
  }, [isVisible, shownTrigger]);

  useLayoutEffect(() => {
    if (!isVisible || !shownTrigger) {
      setCardLeft(null);
      return;
    }
    const width = cardRef.current?.offsetWidth || 288;
    const margin = 8;
    const center = (shownTrigger.left + shownTrigger.right) / 2;
    const clamped = Math.max(margin, Math.min(center - width / 2, window.innerWidth - width - margin));
    setCardLeft(clamped);
  }, [isVisible, shownTrigger]);

  if (!isVisible || !shownTrigger) return null;

  const info = resolvePreview(shownTrigger.target, shownTrigger.alias);
  const above = shownTrigger.top > 170 || window.innerHeight - shownTrigger.bottom < 140;
  const showPath = Boolean(info.path && info.path !== `${info.title}.md` && info.path !== info.title);
  const showTargetAliasNote = Boolean(info.alias && info.alias !== info.title);

  return createPortal(
    <div
      ref={cardRef}
      id={wikiPreviewId}
      role="tooltip"
      aria-label={`Preview for ${info.title}`}
      className={cn(
        'pointer-events-none fixed z-30 w-72 max-w-[calc(100dvw-1rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100',
      )}
      style={{
        left: `${cardLeft ?? Math.max(8, shownTrigger.left)}px`,
        ...(above
          ? { bottom: `${Math.max(8, window.innerHeight - shownTrigger.top + 6)}px` }
          : { top: `${Math.min(window.innerHeight - 16, shownTrigger.bottom + 6)}px` }),
      }}
    >
      <div className="flex items-start gap-2">
        {info.status === 'resolved' ? (
          <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        ) : info.status === 'ambiguous' ? (
          <FolderTree aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : info.status === 'inactive' ? (
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 flex-1 wrap-anywhere text-sm font-semibold leading-snug">{info.title}</p>
            {info.status !== 'resolved' && (
              <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
                {info.status === 'missing' ? 'Missing' : info.status === 'ambiguous' ? 'Ambiguous' : 'Unavailable'}
              </span>
            )}
          </div>
          {showPath && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{info.path}</p>
          )}
          {showTargetAliasNote && info.status === 'resolved' && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">Shown as “{info.alias}”</p>
          )}
        </div>
      </div>

      {info.status === 'resolved' && (
        <p className={cn('mt-2 text-xs leading-relaxed wrap-anywhere', info.snippet ? 'line-clamp-4 text-foreground/90' : 'italic text-muted-foreground')}>
          {info.snippet || 'Empty note.'}
        </p>
      )}
      {info.status === 'inactive' && (
        <div className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>This note is archived or in Trash. Restore it to open.</p>
          {info.snippet && <p className="line-clamp-3 text-foreground/80">{info.snippet}</p>}
        </div>
      )}
      {info.status === 'ambiguous' && (
        <div className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>Multiple notes share this name. Specify a folder path to disambiguate.</p>
          {info.matches && info.matches.length > 0 && (
            <p className="truncate font-medium text-foreground/80">{info.matches.slice(0, 3).join(', ')}</p>
          )}
        </div>
      )}
      {info.status === 'missing' && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {info.canCreate
            ? 'Note does not exist yet. Activate this link to create it.'
            : 'Target path is not valid for creating a note.'}
        </p>
      )}
    </div>,
    document.body,
  );
}
