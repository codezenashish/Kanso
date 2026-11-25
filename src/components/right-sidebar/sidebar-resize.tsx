import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { clampSidebarWidth, sidebarMaxWidth, sidebarMinWidth } from './sidebar-preferences';

export function useSidebarWidth(sidebar: RefObject<HTMLElement | null>, preferredWidth: number) {
  const [available, setAvailable] = useState<number>();
  useLayoutEffect(() => {
    const parent = sidebar.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailable(parent.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    measure();
    return () => observer.disconnect();
  }, [sidebar]);
  const max = available === undefined ? sidebarMaxWidth : Math.max(0, Math.min(
    sidebarMaxWidth, Math.max(176, Math.round(available * 0.6)), available - 72,
  ));
  const min = Math.min(sidebarMinWidth, max);
  return { min, max, width: clampSidebarWidth(preferredWidth, min, max) };
}

export function SidebarResize({ width, min, max, onResize }: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}) {
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  if (min >= max) return null;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize note sidebar"
      aria-controls="note-sidebar-content"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      className="group absolute inset-y-0 left-0 z-10 w-2 touch-none cursor-col-resize select-none outline-none"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        stopDrag.current?.();
        const { pointerId, clientX: startX, currentTarget } = event;
        currentTarget.focus({ preventScroll: true });
        const controller = new AbortController();
        const { signal } = controller;
        const finish = () => {
          controller.abort();
          stopDrag.current = null;
        };
        const stop = (next: PointerEvent) => {
          if (next.pointerId === pointerId) finish();
        };
        stopDrag.current = finish;
        window.addEventListener('pointermove', (next) => {
          if (next.pointerId === pointerId) onResize(clampSidebarWidth(width + startX - next.clientX, min, max));
        }, { signal });
        window.addEventListener('pointerup', stop, { signal });
        window.addEventListener('pointercancel', stop, { signal });
        window.addEventListener('blur', finish, { signal });
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const next = event.key === 'ArrowLeft' ? width + step
          : event.key === 'ArrowRight' ? width - step
          : event.key === 'Home' ? min
          : event.key === 'End' ? max : null;
        if (next === null) return;
        event.preventDefault();
        onResize(clampSidebarWidth(next, min, max));
      }}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-px bg-sidebar-border group-hover:bg-sidebar-primary/60 group-focus-visible:w-0.5 group-focus-visible:bg-sidebar-ring" />
    </div>
  );
}
