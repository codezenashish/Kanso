import { inlineText, parseNoteMarkdown, walkMarkdown, type NoteLink } from '@/lib/note-markdown';
import { resolveWikiLink, type WikiIndex, type WikiNote } from '@/lib/wiki-index';
import { plainWikiText, wikiLabel } from '@/lib/wiki-markdown';

export type LinkedNote = {
  note: WikiNote;
  count: number;
  references?: { offset: number; context: string }[];
};

export type ExternalNoteLink = { href: string; host: string; label: string; count: number };
export type UnresolvedNoteLink = { target: string; name: string; detail: string; count: number; wiki: boolean };

function increment<T extends { count: number }>(entries: Map<string, T>, key: string, entry: Omit<T, 'count'>) {
  const existing = entries.get(key);
  if (existing) existing.count++;
  else entries.set(key, { ...entry, count: 1 } as T);
}

export function groupNoteLinks(index: WikiIndex, noteId: string, markdown: NoteLink[]) {
  const outgoing = new Map<string, LinkedNote>();
  const backlinks = new Map<string, LinkedNote>();
  const external = new Map<string, ExternalNoteLink>();
  const unresolved = new Map<string, UnresolvedNoteLink>();

  for (const link of index.outgoing.get(noteId) ?? []) {
    const note = link.targetId ? index.catalog.notes.get(link.targetId) : undefined;
    if (note?.active) {
      increment(outgoing, note.id, { note });
    } else {
      const target = link.target;
      increment(unresolved, 'wiki:' + (note?.id ?? target.normalize('NFC').toLowerCase()), {
        target, name: note?.name ?? wikiLabel(target),
        detail: note?.path ?? target.replace(/^\//, ''),
        wiki: true,
      });
    }
  }

  for (const link of index.incoming.get(noteId) ?? []) {
    const note = index.catalog.notes.get(link.sourceId);
    if (!note?.active) continue;
    const reference = { offset: link.start, context: link.context };
    const group = backlinks.get(note.id);
    if (group) {
      group.count++;
      group.references?.push(reference);
    } else {
      backlinks.set(note.id, { note, count: 1, references: [reference] });
    }
  }

  const origin = 'https://workspace.invalid';
  const sourcePath = index.catalog.notes.get(noteId)?.path ?? '';
  const sourceUrl = origin + '/' + sourcePath.split('/').map(encodeURIComponent).join('/');
  for (const { label, target } of markdown) {
    if (target.startsWith('#')) continue;
    try {
      const url = new URL(target, sourceUrl);
      if (url.origin === origin) {
        const path = decodeURIComponent(url.pathname);
        const note = resolveWikiLink(index.catalog, path);
        if (note?.active) increment(outgoing, note.id, { note });
        else increment(unresolved, 'markdown:' + path, { target, name: label, detail: path.slice(1), wiki: false });
      } else if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
        const host = url.host || url.pathname;
        increment(external, url.href, { href: url.href, host, label: label === target || label === url.href ? host : label });
      }
    } catch {
      increment(unresolved, 'markdown:' + target, { target, name: label, detail: target, wiki: false });
    }
  }

  return {
    outgoing: [...outgoing.values()],
    backlinks: [...backlinks.values()],
    external: [...external.values()],
    unresolved: [...unresolved.values()],
  };
}

export function notePreviewText(source: string, markdown: boolean) {
  const bounded = source.slice(0, 8192);
  if (!markdown) return excerpt(bounded);
  const document = parseNoteMarkdown(bounded);
  for (const node of walkMarkdown(document)) {
    if (node.type === 'paragraph' || node.type === 'tableCell' || node.type === 'code') {
      const preview = excerpt(plainWikiText(inlineText(node)));
      if (preview) return preview;
    }
  }
  const heading = document.children.find((node) => node.type === 'heading');
  return heading ? excerpt(plainWikiText(inlineText(heading))) : '';
}

function excerpt(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 190 ? clean.slice(0, 189).trimEnd() + '…' : clean;
}
