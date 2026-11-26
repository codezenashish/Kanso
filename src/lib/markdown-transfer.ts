import { invoke } from '@tauri-apps/api/core';
import { isMap, parseDocument, stringify } from 'yaml';
import { parseNoteMarkdown, walkMarkdown } from './note-markdown';
import { readYamlProperties } from './note-frontmatter';
import { destinationSiblings, nameConflict } from './workspace-mutation';
import { find, getNoteFormat, insert, type NoteProperty, type WorkspaceNode } from './workspace-tree';

const propertySuffix = '.kanso-properties.json';
const assetFolder = '_kanso-assets';
const markdownExtension = /\.(?:md|markdown)$/i;
const assetName = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp|pdf|txt)$/;
const maxNoteBytes = 4 * 1024 * 1024;
const maxBatchBytes = 48 * 1024 * 1024;
const maxAssetBytes = 25 * 1024 * 1024;
const maxEntries = 2500;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type ImportEntry = {
  source: number;
  path: string[];
  content: string | null;
  propertiesJson: string | null;
  assets: { name: string; bytes: number[] | Uint8Array }[];
};
export type ImportBatch = { entries: ImportEntry[]; issues: string[] };
export type ImportChoice = 'rename' | 'skip';
type ExportEntry = { id?: string; path: string[]; content?: string; propertiesJson?: string };
export type ExportReport = { directory: string; written: number; issues: string[] };

export const pickMarkdownImport = (folders: boolean) => invoke<ImportBatch | null>('pick_markdown_import', { folders });
export const exportMarkdownFiles = (entries: ExportEntry[]) => invoke<ExportReport | null>('export_markdown_files', { entries });

function componentIsSafe(part: string) {
  return !!part && part !== '.' && part !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(part);
}

function pathKey(source: number, path: string[]) {
  return JSON.stringify([source, ...path]);
}

function readProperties(raw: string, label: string, issues: string[]): NoteProperty[] | undefined {
  try {
    const data: unknown = JSON.parse(raw);
    if (Array.isArray(data) && data.every((value) =>
      value !== null && typeof value === 'object' && typeof value.name === 'string' && typeof value.value === 'string')) {
      return data.map(({ name, value }) => ({ name, value }));
    }
  } catch {
    // Keep the note when optional sidecar metadata cannot be decoded.
  }
  issues.push(`${label}: the property sidecar is invalid.`);
}

function suffixedName(name: string, number: number, file: boolean) {
  const extension = file ? /\.[^.]+$/.exec(name)?.[0] ?? '' : '';
  return `${extension ? name.slice(0, -extension.length) : name} (${number})${extension}`;
}

export function planMarkdownImport(tree: WorkspaceNode[], parent: string | null, batch: ImportBatch, choice: ImportChoice) {
  if (!destinationSiblings(tree, parent)) throw new Error('The import destination is no longer available.');
  const folders = new Map<string, string>();
  const imported: { node: WorkspaceNode; entry: ImportEntry }[] = [];
  const issues = [...batch.issues];
  let skipped = 0;
  let renamed = 0;
  let next = tree;

  for (const entry of batch.entries) {
    const { source, path, content } = entry;
    const label = path.join('/');
    const originalName = path[path.length - 1];
    const file = content !== null;
    if (!path.length || path.length > 48 || !path.every(componentIsSafe) || (file && !markdownExtension.test(originalName))) {
      issues.push(`${label}: skipped an unsupported import path.`);
      skipped++;
      continue;
    }
    const destination = path.length === 1 ? parent : folders.get(pathKey(source, path.slice(0, -1)));
    if (destination === undefined) {
      skipped++;
      continue;
    }
    const siblings = destinationSiblings(next, destination);
    if (!siblings) {
      skipped++;
      continue;
    }
    let name = originalName;
    let sequence = 2;
    if (nameConflict(siblings, name)) {
      if (choice === 'skip') {
        skipped++;
        issues.push(`${label}: skipped a duplicate name.`);
        continue;
      }
      do { name = suffixedName(originalName, sequence++, file); } while (nameConflict(siblings, name));
      renamed++;
      issues.push(`${label}: imported as ${name}.`);
    }
    const id = crypto.randomUUID();
    if (file) {
      const properties = entry.propertiesJson === null ? undefined : readProperties(entry.propertiesJson, label, issues);
      const node: WorkspaceNode = { id, kind: 'file', name, content, properties };
      next = insert(next, destination, node);
      imported.push({ node, entry });
    } else {
      next = insert(next, destination, { id, kind: 'folder', name, children: [] });
      folders.set(pathKey(source, path), id);
    }
  }
  return { tree: next, imported, folderCount: folders.size, skipped, renamed, issues };
}

function sidebarMarkdown(node: WorkspaceNode, issues: string[], path: string) {
  const content = node.content ?? '';
  if (!node.properties?.length || getNoteFormat(node.name) !== 'markdown') return content;
  const frontmatter = parseNoteMarkdown(content).children[0];
  const isYaml = frontmatter?.type === 'yaml';
  const prefix = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = content.slice(prefix.length);
  const newline = /\r\n|\r|\n/.exec(source)?.[0] ?? '\n';
  const yaml = isYaml ? parseDocument(frontmatter.value) : null;
  const properties = isYaml ? readYamlProperties(frontmatter.value) : null;
  const key = (name: string) => name.normalize('NFC').toLowerCase();
  if (properties?.invalid || (yaml && yaml.contents !== null && (!isMap(yaml.contents) || yaml.contents.flow))
      || (!isYaml && /^(?:---|\+\+\+)(?:\r\n|\r|\n|$)/.test(source))) {
    issues.push(`${path}: kept existing frontmatter unchanged. Sidebar properties are in the sidecar.`);
    return content;
  }
  const existing = new Map(properties?.properties.map(({ name, value }) => [key(name), value]));
  const additions = new Map<string, string>();
  for (const property of node.properties) {
    const id = key(property.name);
    if (existing.has(id)) {
      if (existing.get(id) !== property.value) issues.push(`${path}: kept YAML value for “${property.name}”. The sidebar value is in the sidecar.`);
      continue;
    }
    existing.set(id, property.value);
    additions.set(property.name, property.value);
  }
  if (!additions.size) return content;
  const encoded = stringify(additions, { lineWidth: 0 }).replace(/\n/g, newline);
  if (!isYaml) return `${prefix}---${newline}${encoded}---${newline}${newline}${source}`;
  const end = frontmatter.position?.end.offset;
  const closing = end === undefined ? null : /(?:\r\n|\r|\n)(---|\.\.\.)[ \t]*$/.exec(content.slice(0, end));
  if (!closing) {
    issues.push(`${path}: could not safely update YAML. Sidebar properties are in the sidecar.`);
    return content;
  }
  const offset = closing.index + closing[0].length - closing[0].trimStart().length;
  return content.slice(0, offset) + encoded + content.slice(offset);
}

function portableName(raw: string) {
  let name = raw.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '') || 'Untitled';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.toLowerCase() === assetFolder) name = '_' + name;
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > 190) {
    const extension = /\.[a-z0-9]{1,12}$/i.exec(name)?.[0] ?? '';
    let stem = '';
    for (const character of name.slice(0, name.length - extension.length)) {
      if (encoder.encode(stem + character + extension).length > 190) break;
      stem += character;
    }
    name = stem + extension;
  }
  return name;
}

export function planMarkdownExport(tree: WorkspaceNode[], selection: string | string[] | null, includeTrash = false) {
  const ids = typeof selection === 'string' ? [selection] : selection;
  const roots = ids?.map((id) => find(tree, id)).filter((node): node is WorkspaceNode => !!node);
  const selected = roots?.filter((node) => !roots.some((root) => root !== node && find(root.children ?? [], node.id))) ?? tree;
  const entries: ExportEntry[] = [];
  const issues: string[] = [];

  function visit(nodes: WorkspaceNode[], parent: string[]) {
    const names = new Set<string>();
    for (const node of nodes) {
      if (node.status === 'trashed' && !includeTrash) continue;
      const file = node.kind === 'file';
      const original = file && !/\.(?:md|markdown|txt|ya?ml)$/i.test(node.name) ? node.name + '.md' : node.name;
      const safe = portableName(original);
      let name = safe;
      let sequence = 2;
      const caseKey = (value: string) => value.normalize('NFC').toLowerCase();
      while (names.has(caseKey(name)) || (file && names.has(caseKey(name + propertySuffix)))) {
        name = suffixedName(safe, sequence++, file);
      }
      names.add(caseKey(name));
      if (file && node.properties?.length) names.add(caseKey(name + propertySuffix));
      const path = [...parent, name];
      if (original !== name) issues.push(`${node.name}: exported as ${path.join('/')}.`);
      if (!file) {
        entries.push({ path });
        visit(node.children ?? [], path);
      } else {
        const content = sidebarMarkdown(node, issues, path.join('/'));
        if (getNoteFormat(node.name) === 'markdown') {
          const local = portableAssetReferences(content);
          const unresolved = new Set([...local.unresolved, ...local.references.map(({ name }) => assetFolder + '/' + name)]);
          for (const url of unresolved) issues.push(`${path.join('/')}: kept unresolved local link ${url}.`);
        }
        entries.push({ id: node.id, path, content, propertiesJson: node.properties?.length ? JSON.stringify(node.properties) : undefined });
      }
    }
  }

  visit(selected, []);
  return { entries, issues };
}

export function portableAssetReferences(content: string) {
  const references: { name: string; start: number; end: number; fragment: string }[] = [];
  const unresolved = new Set<string>();
  for (const node of walkMarkdown(parseNoteMarkdown(content))) {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') continue;
    const hash = node.url.indexOf('#');
    const url = hash < 0 ? node.url : node.url.slice(0, hash);
    const fragment = hash < 0 ? '' : node.url.slice(hash);
    const name = url.startsWith(assetFolder + '/') ? url.slice(assetFolder.length + 1) : '';
    if (!assetName.test(name)) {
      if ((node.type === 'image' || /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(url)) && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url)) unresolved.add(node.url);
      continue;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = content.slice(start, end);
    const destination = node.type === 'definition' ? /\]:\s*<?([^\s>]+)/g : /\]\(\s*<?([^\s>)]+)(?:>|\s|\))/g;
    const match = [...raw.matchAll(destination)].find((part) => part[1] === node.url);
    if (!match) {
      unresolved.add(node.url);
      continue;
    }
    const offset = start + match.index + match[0].indexOf(match[1]);
    references.push({ name, start: offset, end: offset + match[1].length, fragment });
  }
  return { references, unresolved: [...unresolved] };
}

type DroppedEntry = { source: number; path: string[]; file: File | null };

function entryFile(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

async function* droppedEntries(entry: FileSystemEntry, source: number, parent: string[]): AsyncGenerator<DroppedEntry> {
  if (parent.length >= 48) throw new Error('The dropped folder exceeds the nesting limit.');
  const path = [...parent, entry.name];
  if (entry.isFile) {
    yield { source, path, file: await entryFile(entry as FileSystemFileEntry) };
    return;
  }
  if (!entry.isDirectory) return;
  yield { source, path, file: null };
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  while (true) {
    const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!children.length) return;
    for (const child of children) yield* droppedEntries(child, source, path);
  }
}

export async function readMarkdownDrop(transfer: DataTransfer): Promise<ImportBatch> {
  // Read the drag data store before yielding. Browsers protect it after the drop handler returns.
  const roots = Array.from(transfer.items).filter((item) => item.kind === 'file').map((item) => ({
    entry: item.webkitGetAsEntry?.(), file: item.getAsFile(),
  }));
  const files = Array.from(transfer.files);
  const items: DroppedEntry[] = [];
  const issues: string[] = [];
  for (const [source, { entry, file }] of roots.entries()) {
    try {
      if (entry) {
        for await (const item of droppedEntries(entry, entry.isDirectory ? source + 1 : 0, [])) {
          if (items.length >= maxEntries) throw new Error('The import entry limit was reached.');
          items.push(item);
        }
      } else if (file && items.length < maxEntries) items.push({ source: 0, path: [file.name], file });
    } catch (error) {
      issues.push(`${entry?.name ?? file?.name ?? 'Dropped item'}: ${String(error)}`);
    }
  }
  if (!roots.length) for (const file of files.slice(0, maxEntries)) items.push({ source: 0, path: [file.name], file });
  const byPath = new Map(items.map((entry) => [pathKey(entry.source, entry.path), entry.file]));
  let remaining = maxBatchBytes;
  const assets = new Map<File, Uint8Array>();
  const entries: ImportEntry[] = [];

  async function read(file: File, limit: number) {
    if (file.size > Math.min(limit, remaining)) throw new Error('File or batch exceeds the size limit.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    remaining -= bytes.length;
    return bytes;
  }

  for (const { source, path, file } of items) {
    const name = path[path.length - 1];
    if (path.some((part) => part.toLowerCase() === assetFolder)) continue;
    if (file && !markdownExtension.test(name)) continue;
    const entry: ImportEntry = { source, path, content: null, propertiesJson: null, assets: [] };
    if (file) {
      try {
        entry.content = decoder.decode(await read(file, maxNoteBytes));
      } catch (error) {
        issues.push(`${path.join('/')}: expected a readable UTF-8 Markdown file (${String(error)}).`);
        continue;
      }
      const parent = path.slice(0, -1);
      const properties = byPath.get(pathKey(source, [...parent, name + propertySuffix]));
      if (properties) {
        try { entry.propertiesJson = decoder.decode(await read(properties, maxNoteBytes)); }
        catch { issues.push(`${path.join('/')}: could not read the sidebar properties.`); }
      }
      for (const asset of new Set(portableAssetReferences(entry.content).references.map(({ name }) => name))) {
        const related = byPath.get(pathKey(source, [...parent, assetFolder, asset]));
        if (!related) continue;
        try {
          const bytes = assets.get(related) ?? await read(related, maxAssetBytes);
          assets.set(related, bytes);
          entry.assets.push({ name: asset, bytes });
        } catch {
          issues.push(`${path.join('/')}: attachment ${asset} exceeded the size limit or could not be read.`);
        }
      }
    }
    entries.push(entry);
  }
  return { entries, issues };
}
