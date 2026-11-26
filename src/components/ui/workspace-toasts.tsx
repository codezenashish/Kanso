import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './button';

type ToastInput = {
  key: string;
  kind: 'success' | 'error' | 'info';
  message: string;
  action?: { label: string; run: () => void };
  duration?: number;
};

type Toast = ToastInput & { id: number; expires: number };
const ToastContext = createContext<{ notify: (toast: ToastInput) => void; dismissByKey: (key: string) => void } | null>(null);

export function useWorkspaceToast() {
  const feedback = useContext(ToastContext);
  if (!feedback) throw new Error('Workspace toast provider is missing');
  return feedback;
}

export function WorkspaceToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const notify = useCallback((input: ToastInput) => {
    const duration = input.duration ?? (input.kind === 'error' ? Infinity : 5000);
    const toast = { ...input, id: ++nextId.current, expires: performance.now() + duration };
    setToasts((current) => [...current.filter(({ key }) => key !== toast.key), toast]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const dismissByKey = useCallback((key: string) => {
    setToasts((current) => current.some((toast) => toast.key === key)
      ? current.filter((toast) => toast.key !== key) : current);
  }, []);
  const feedback = useMemo(() => ({ notify, dismissByKey }), [notify, dismissByKey]);
  const latestStatus = [...toasts].reverse().find(({ kind }) => kind !== 'error');
  const latestError = [...toasts].reverse().find(({ kind }) => kind === 'error');

  return (
    <ToastContext.Provider value={feedback}>
      {children}
      {createPortal(
        <div aria-label="Notifications" role="region" className="pointer-events-none fixed inset-x-2 bottom-2 z-30 flex max-h-[min(50dvh,24rem)] flex-col items-end gap-2 overflow-y-auto sm:inset-x-auto sm:right-3">
          <div role="status" aria-atomic="true" className="sr-only">
            {latestStatus?.message}
            {latestStatus?.action && ' Action available in Notifications.'}
          </div>
          <div role="alert" aria-atomic="true" className="sr-only">
            {latestError?.message}
            {latestError?.action && ' Action available in Notifications.'}
          </div>
          {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  useEffect(() => {
    if (!Number.isFinite(toast.expires)) return;
    const timer = window.setTimeout(dismiss, Math.max(0, toast.expires - performance.now()));
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.expires]);

  useLayoutEffect(() => {
    const element = card.current;
    return () => {
      if (element?.contains(document.activeElement) && previousFocus.current?.isConnected) {
        previousFocus.current.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div ref={card} role="group" aria-label={toast.message}
      className="pointer-events-auto flex w-full max-w-80 shrink-0 items-center gap-2 rounded-lg border border-border bg-popover p-2 text-sm text-popover-foreground shadow-lg sm:w-80"
      onFocusCapture={(event) => {
        const previous = event.relatedTarget;
        if (previous instanceof HTMLElement && !event.currentTarget.contains(previous)) previousFocus.current = previous;
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}>
      <p className="min-w-0 flex-1 wrap-break-word">{toast.message}</p>
      {toast.action && (
        <Button type="button" size="xs" variant="outline" onClick={() => {
          dismiss();
          if (performance.now() < toast.expires) toast.action?.run();
        }}>{toast.action.label}</Button>
      )}
      <Button type="button" size="icon-xs" variant="ghost" aria-label={`Dismiss notification: ${toast.message}`} onClick={dismiss}>
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
