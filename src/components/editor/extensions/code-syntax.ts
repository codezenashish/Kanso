import { common, createLowlight } from 'lowlight';

type HastNode = {
  type: string;
  value?: string;
  properties?: { className?: string[] | string };
  children?: HastNode[];
};

const lowlight = createLowlight(common);

const languageAliases: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  xml: 'xml',
  yml: 'yaml',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  md: 'markdown',
  psql: 'sql',
  postgres: 'sql',
  sqlite: 'sql',
};

function resolveHighlightLanguage(params: string | null | undefined): string | null {
  const token = String(params ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!token) return null;
  const mapped = languageAliases[token] ?? token;
  return lowlight.registered(mapped) ? mapped : null;
}

type CodeToken = { from: number; to: number; className: string };

export function highlightCodeTokens(source: string, params: string | undefined): CodeToken[] {
  const language = resolveHighlightLanguage(params);
  if (!language || !source) return [];

  try {
    const tree = lowlight.highlight(language, source) as HastNode;
    const tokens: CodeToken[] = [];
    let offset = 0;

    function collect(nodes: HastNode[], classes: string) {
      for (const node of nodes) {
        if (node.type === 'text') {
          const from = offset;
          offset += node.value?.length ?? 0;
          if (offset > from && classes) tokens.push({ from, to: offset, className: classes });
        } else if (node.children) {
          const rawClasses = node.properties?.className;
          const ownClasses = Array.isArray(rawClasses) ? rawClasses.join(' ') : rawClasses;
          collect(node.children, ownClasses ? (classes ? classes + ' ' + ownClasses : ownClasses) : classes);
        }
      }
    }

    collect(tree.children ?? [], '');
    return tokens;
  } catch {
    return [];
  }
}
