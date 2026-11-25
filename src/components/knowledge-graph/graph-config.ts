import { forceCollide, type ForceLink, type ForceManyBody, type SimulationNodeDatum } from 'd3-force';
import type { WikiNote } from '@/lib/wiki-index';

export type CanvasNote = WikiNote & Omit<SimulationNodeDatum, 'fx' | 'fy'>;
export type CanvasEdge = { source: string | CanvasNote; target: string | CanvasNote; count: number };

export function linkNoteId(note: string | CanvasNote) {
  return typeof note === 'string' ? note : note.id;
}

export function graphForces(size: number, compact: boolean) {
  const large = size >= 1200;
  return {
    cooldownTicks: large ? 66 : 130,
    cooldownTime: large ? 1600 : 2600,
    distance: compact ? 39 : 51,
    charge: compact ? -42 : -66,
    collision: large ? null : forceCollide<CanvasNote>(compact ? 6 : 8).strength(0.55),
  };
}

export type GraphCharge = ForceManyBody<CanvasNote>;
export type GraphLinkForce = ForceLink<CanvasNote, CanvasEdge>;

export function readGraphColors(element: HTMLElement) {
  const style = getComputedStyle(element);
  const read = (property: string) => style.getPropertyValue(property).trim();
  return {
    node: read('--muted-foreground'),
    edge: read('--border'),
    active: read('--sidebar-primary'),
    foreground: read('--foreground'),
    background: read('--background'),
    font: style.fontFamily,
  };
}
