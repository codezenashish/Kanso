import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { Maximize, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/ui/theme-toggle';
import type { NoteGraph } from './graph-data';
import { graphForces, linkNoteId, readGraphColors, type CanvasEdge, type CanvasNote, type GraphCharge, type GraphLinkForce } from './graph-config';

type GraphCanvasProps = {
  graph: NoteGraph;
  activeId: string;
  compact: boolean;
  onOpenNote: (id: string) => void;
};

function sameGraph(previous: NoteGraph, next: NoteGraph) {
  return previous.nodes.length === next.nodes.length && previous.links.length === next.links.length
    && previous.nodes.every((note, index) => note === next.nodes[index])
    && previous.links.every((edge, index) => {
      const other = next.links[index];
      return edge.source === other.source && edge.target === other.target && edge.count === other.count;
    });
}

export function GraphCanvas({ graph, activeId, compact, onOpenNote }: GraphCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<ForceGraphMethods<CanvasNote, CanvasEdge>>(undefined);
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<ReturnType<typeof readGraphColors>>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string>();
  const shouldFit = useRef(true);
  const committed = useRef<{ graph: NoteGraph; data: { nodes: CanvasNote[]; links: CanvasEdge[] } }>(null);
  const settings = useMemo(() => graphForces(graph.nodes.length, compact), [graph.nodes.length, compact]);
  const data = useMemo(() => {
    const previous = committed.current;
    if (previous && sameGraph(previous.graph, graph)) return previous.data;
    const positions = new Map(previous?.data.nodes.map((node) => [node.id, node]));
    return {
      nodes: graph.nodes.map((note): CanvasNote => {
        const previous = positions.get(note.id);
        return { ...note, x: previous?.x, y: previous?.y };
      }),
      // The force engine mutates its input and replaces IDs with node objects.
      links: graph.links.map((edge) => ({ ...edge })),
    };
  }, [graph]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (host.current) setColors(readGraphColors(host.current));
  }, [resolvedTheme]);

  useLayoutEffect(() => {
    committed.current = { graph, data };
  }, [graph, data]);

  const ready = Boolean(colors && size.width && size.height && data.nodes.length);
  useLayoutEffect(() => {
    if (!ready || !canvas.current) return;
    shouldFit.current = true;
    setHoverId(undefined);
    const graphView = canvas.current;
    (graphView.d3Force('charge') as GraphCharge | undefined)?.strength(settings.charge).distanceMax(300);
    (graphView.d3Force('link') as GraphLinkForce | undefined)?.distance(settings.distance);
    graphView.d3Force('collision', settings.collision);
    graphView.d3ReheatSimulation();
  }, [data, ready, settings]);

  useLayoutEffect(() => {
    if (!ready || !canvas.current) return;
    const graphView = canvas.current;
    const syncVisibility = () => {
      if (document.hidden) graphView.pauseAnimation();
      else graphView.resumeAnimation();
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, [ready]);

  const hover = hoverId ? graph.nodes.find((node) => node.id === hoverId) : undefined;
  const connected = hover ? graph.neighbors.get(hover.id) : undefined;
  const fit = useCallback(() => {
    const view = canvas.current;
    const bounds = view?.getGraphBbox();
    if (!view || !bounds || !size.width || !size.height) return;
    const [left, right] = bounds.x;
    const [top, bottom] = bounds.y;
    if (![left, right, top, bottom].every(Number.isFinite)) return;
    const padding = Math.min(compact ? 38 : 52, size.width / 4, size.height / 4);
    const zoom = data.nodes.length === 1 ? 2 : Math.min(
      (size.width - 2 * padding) / Math.max(1, right - left),
      (size.height - 2 * padding) / Math.max(1, bottom - top),
    );
    view.centerAt((left + right) / 2, (top + bottom) / 2);
    view.zoom(Math.max(0.002, Math.min(12, zoom)));
  }, [compact, data.nodes.length, size.height, size.width]);

  useLayoutEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit, ready]);


  return (
    <div ref={host} role="region" aria-label={compact ? 'Local graph canvas' : 'Knowledge graph canvas'}
      className="relative min-h-44 flex-1 overflow-hidden rounded-lg border border-border bg-background">
      {ready && colors && (
        <ForceGraph2D<CanvasNote, CanvasEdge>
          ref={canvas}
          graphData={data}
          width={size.width}
          height={size.height}
          backgroundColor={colors.background}
          minZoom={0.002}
          maxZoom={12}
          nodeLabel=""
          linkLabel=""
          cooldownTicks={settings.cooldownTicks}
          cooldownTime={settings.cooldownTime}
          autoPauseRedraw
          onEngineStop={() => {
            if (shouldFit.current) { shouldFit.current = false; fit(); }
          }}
          onNodeClick={(node) => onOpenNote(node.id)}
          onNodeHover={(node) => setHoverId(node?.id)}
          onNodeDrag={() => { shouldFit.current = false; }}
          showPointerCursor={(element) => Boolean(element && 'id' in element)}
          linkHoverPrecision={0}
          linkCurvature={(edge) => linkNoteId(edge.source) === linkNoteId(edge.target) ? 0.7 : 0}
          linkColor={(edge) => hover && (linkNoteId(edge.source) === hover.id || linkNoteId(edge.target) === hover.id)
            ? colors.active : colors.edge}
          linkWidth={(edge) => hover && (linkNoteId(edge.source) === hover.id || linkNoteId(edge.target) === hover.id) ? 1.4 : 0.65}
          nodePointerAreaPaint={(node, color, context, scale) => {
            if (node.x === undefined || node.y === undefined) return;
            context.fillStyle = color;
            context.beginPath();
            context.arc(node.x, node.y, Math.max(5 / scale, 4), 0, 2 * Math.PI);
            context.fill();
          }}
          nodeCanvasObject={(node, context, scale) => {
            if (node.x === undefined || node.y === undefined) return;
            const active = node.id === activeId;
            const hovered = hover?.id === node.id;
            const highlighted = active || hovered || connected?.has(node.id);
            const radius = Math.max((active ? 5 : 3) / scale, active ? 3.7 : 2.2);
            context.globalAlpha = hover && !highlighted ? 0.35 : 1;
            context.fillStyle = highlighted ? colors.active : colors.node;
            context.beginPath();
            context.arc(node.x, node.y, radius, 0, Math.PI * 2);
            context.fill();
            if (active) {
              context.strokeStyle = colors.active;
              context.lineWidth = 1 / scale;
              context.beginPath();
              context.arc(node.x, node.y, radius + 3 / scale, 0, Math.PI * 2);
              context.stroke();
            }
            if (active || hovered || (!hover && (data.nodes.length <= (compact ? 14 : 36) || scale >= 1.45))
              || (connected?.has(node.id) && connected.size <= 18)) {
              context.font = `${active ? 600 : 400} ${11 / scale}px ${colors.font}`;
              context.textAlign = 'center';
              context.textBaseline = 'top';
              const name = node.name.length > 34 ? node.name.slice(0, 33) + '…' : node.name;
              const y = node.y + radius + 5 / scale;
              context.lineWidth = 3 / scale;
              context.strokeStyle = colors.background;
              context.strokeText(name, node.x, y);
              context.fillStyle = colors.foreground;
              context.fillText(name, node.x, y);
            }
            context.globalAlpha = 1;
          }}
        />
      )}
      {!data.nodes.length && <p role="status" className="absolute inset-0 grid place-items-center px-3 text-center text-xs text-muted-foreground">{compact && !activeId ? 'Open a note to see its connections.' : 'No notes match this graph.'}</p>}
      {ready && (
        <div className="absolute end-1.5 top-1.5 flex gap-0.5 rounded-md border border-border bg-background p-0.5">
          {[
            { name: 'Zoom out', icon: Minus, act: () => canvas.current?.zoom(Math.max(0.002, canvas.current.zoom() / 1.4), 0) },
            { name: 'Zoom in', icon: Plus, act: () => canvas.current?.zoom(Math.min(12, canvas.current.zoom() * 1.4), 0) },
            { name: 'Fit graph', icon: Maximize, act: fit },
          ].map(({ name, icon: Icon, act }) => (
            <Button key={name} variant="ghost" size="icon-xs" aria-label={name} title={name} onClick={() => {
              shouldFit.current = false;
              act();
            }}><Icon aria-hidden="true" /></Button>
          ))}
        </div>
      )}
      {hover && (
        <div role="tooltip" className="pointer-events-none absolute inset-x-2 bottom-2 w-fit max-w-[calc(100%-1rem)] rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm">
          <div className="truncate font-medium">{hover.name}</div>
          <div className="truncate text-muted-foreground">{hover.path}</div>
        </div>
      )}
    </div>
  );
}
