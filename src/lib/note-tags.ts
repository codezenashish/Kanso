import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { NoteProperty, WorkspaceNode } from './database/workspace-types';
import { getNoteFormat } from './workspace-tree';

export function tagKey(value: string) {
  return value.trim().normalize('NFC').toLowerCase().normalize('NFC');
}

export function isTagsProperty(property: NoteProperty) {
  return tagKey(property.name) === 'tags';
}

export function validTagName(value: string) {
  return !!value.trim() && !/[,\u0000-\u001f\u007f]/.test(value);
}

export function uniqueTags(values: string[]) {
  const tags = new Map<string, string>();
  for (const value of values) {
    const key = tagKey(value);
    if (key && !tags.has(key)) tags.set(key, value.trim());
  }
  return [...tags.values()];
}

type YamlTags =
  | { kind: 'none' | 'blocked'; values: string[] }
  | { kind: 'editable'; values: string[]; start: number; end: number };

function readYamlTags(note: WorkspaceNode): YamlTags {
  const none: YamlTags = { kind: 'none', values: [] };
  const blocked: YamlTags = { kind: 'blocked', values: [] };
  const content = note.content ?? '';
  if (getNoteFormat(note.name) !== 'markdown') return none;
  const start = /^\uFEFF?---[ \t]*(?:\r\n|\n|\r)/.exec(content)?.[0].length;
  if (start === undefined) return none;
  const remainder = content.slice(start);
  const end = /^---[ \t]*(?=\r\n|\r|\n|$)/m.exec(remainder)?.index;
  if (end === undefined) return none;
  const source = remainder.slice(0, end);
  try {
    const parsed = parseDocument(source);
    if (parsed.errors.length) return blocked;
    if (parsed.contents === null) return none;
    if (!isMap(parsed.contents)) return blocked;
    const keys = parsed.contents.items.filter((item) =>
      isScalar(item.key) && typeof item.key.value === 'string' && tagKey(item.key.value) === 'tags');
    if (!keys.length) return none;
    if (keys.length !== 1) return blocked;
    const value = keys[0].value;
    if (isAlias(value) || (!isScalar(value) && !isSeq(value))) return blocked;
    const values: string[] = [];
    if (isScalar(value)) {
      if (value.value !== null && typeof value.value !== 'string') return blocked;
      if (typeof value.value === 'string') values.push(...value.value.split(','));
    } else {
      for (const item of value.items) {
        if (!isScalar(item) || typeof item.value !== 'string' || !validTagName(item.value)) return blocked;
        values.push(item.value);
      }
    }
    const normalized = uniqueTags(values);
    if (value.anchor || value.tag || !value.range || (isSeq(value) && value.items.some((item) =>
      isScalar(item) && (item.anchor || item.tag || item.comment || item.commentBefore)))) {
      return { kind: 'blocked', values: normalized };
    }
    return { kind: 'editable', values: normalized, start: start + value.range[0], end: start + value.range[1] };
  } catch {
    return blocked;
  }
}

type NoteTagState = { tags: string[]; yaml: YamlTags };
const tagCache = new WeakMap<WorkspaceNode, NoteTagState>();

export function readNoteTagState(note: WorkspaceNode): NoteTagState {
  const cached = tagCache.get(note);
  if (cached) return cached;
  const yaml = readYamlTags(note);
  const properties = note.properties?.filter(isTagsProperty).flatMap(({ value }) => value.split(',')) ?? [];
  const state = { tags: uniqueTags([...properties, ...yaml.values]), yaml };
  tagCache.set(note, state);
  return state;
}

export function noteTags(note: WorkspaceNode) {
  return readNoteTagState(note).tags;
}

export function replaceNoteTags(note: WorkspaceNode, values: string[]) {
  const tags = uniqueTags(values);
  const { yaml } = readNoteTagState(note);
  if (yaml.kind === 'blocked') return null;

  let content = note.content;
  if (yaml.kind === 'editable' && content !== undefined) {
    const previous = content.slice(yaml.start, yaml.end);
    const trailingNewline = /(?:\r\n|\r|\n)$/.exec(previous)?.[0] ?? '';
    content = content.slice(0, yaml.start) + (content[yaml.start - 1] === ':' ? ' ' : '') + JSON.stringify(tags) + trailingNewline + (content[yaml.end] === '#' ? ' ' : '') + content.slice(yaml.end);
    const updated = readYamlTags({ ...note, content });
    if (updated.kind !== 'editable' || JSON.stringify(updated.values) !== JSON.stringify(tags)) return null;
  }

  const properties: NoteProperty[] = [];
  const previous = note.properties ?? [];
  const hasSidebarTags = previous.some(isTagsProperty);
  if (hasSidebarTags || yaml.kind === 'none') {
    let added = false;
    for (const property of previous) {
      if (!isTagsProperty(property)) properties.push(property);
      else if (!added && tags.length) {
        properties.push({ ...property, value: tags.join(', ') });
        added = true;
      }
    }
    if (!added && tags.length) properties.push({ name: 'Tags', value: tags.join(', ') });
  } else {
    properties.push(...previous);
  }
  return { ...note, content, properties: properties.length ? properties : undefined };
}
