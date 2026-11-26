export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

export function diffLines(current: string, version: string): DiffLine[] {
  const split = (text: string) => text ? text.replace(/\r\n?/g, '\n').split('\n') : [];
  const before = split(current);
  const after = split(version);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

  const lines: DiffLine[] = before.slice(0, prefix).map((text) => ({ kind: 'same', text }));
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const columns = added.length + 1;
  // Large independent changes use a single removed/added block rather than allocating a large matrix.
  if (removed.length && added.length && (removed.length + 1) * columns <= 1_000_000) {
    const lengths = new Uint32Array((removed.length + 1) * columns);
    for (let row = removed.length - 1; row >= 0; row--) {
      for (let column = added.length - 1; column >= 0; column--) {
        const index = row * columns + column;
        lengths[index] = removed[row] === added[column] ? 1 + lengths[index + columns + 1]
          : Math.max(lengths[index + columns], lengths[index + 1]);
      }
    }
    let row = 0;
    let column = 0;
    while (row < removed.length || column < added.length) {
      if (row < removed.length && column < added.length && removed[row] === added[column]) {
        lines.push({ kind: 'same', text: removed[row++] });
        column++;
      } else if (row < removed.length && (column === added.length
        || lengths[(row + 1) * columns + column] >= lengths[row * columns + column + 1])) {
        lines.push({ kind: 'removed', text: removed[row++] });
      } else {
        lines.push({ kind: 'added', text: added[column++] });
      }
    }
  } else {
    for (const text of removed) lines.push({ kind: 'removed', text });
    for (const text of added) lines.push({ kind: 'added', text });
  }
  if (suffix) for (const text of before.slice(-suffix)) lines.push({ kind: 'same', text });
  return lines;
}
