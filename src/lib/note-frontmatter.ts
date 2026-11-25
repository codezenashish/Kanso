import { parseDocument, stringify } from 'yaml';

export type Frontmatter = {
  properties: { name: string; value: string }[];
  invalid: boolean;
};

export function readYamlProperties(source: string): Frontmatter {
  try {
    const document = parseDocument(source);
    if (!document.errors.length) {
      const entries: unknown = document.toJS({ mapAsMap: true });
      if (entries === null) return { properties: [], invalid: false };
      if (entries instanceof Map) {
        return {
          properties: Array.from(entries, ([key, value]) => ({
            name: typeof key === 'string' ? key : stringify(key, { lineWidth: 0 }).trimEnd(),
            value: typeof value === 'string' ? value : stringify(value, { lineWidth: 0 }).trimEnd(),
          })),
          invalid: false,
        };
      }
    }
  } catch {
    // Invalid or excessively expanded YAML stays available in Source Mode.
  }
  return { properties: [], invalid: true };
}
