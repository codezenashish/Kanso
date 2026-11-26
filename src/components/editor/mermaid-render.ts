import type mermaid from 'mermaid';

type MermaidRenderResult =
  | { svg: string; error: null }
  | { svg: null; error: string };

let renderCounter = 0;
let renderQueue: Promise<void> = Promise.resolve();
let configuredDark: boolean | null = null;

function isDarkTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

function cleanupMermaidErrorElements(renderId: string) {
  if (typeof document === 'undefined') return;
  document.getElementById(renderId)?.remove();
  document.getElementById(`d${renderId}`)?.remove();
}

function readThemePalette(dark: boolean) {
  const fontFamily = typeof document !== 'undefined' && typeof getComputedStyle !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() || 'Geist Variable, system-ui, sans-serif'
    : 'Geist Variable, system-ui, sans-serif';

  return dark
    ? {
        background: '#222222',
        primaryColor: '#2d2d2d',
        primaryTextColor: '#ebe6dc',
        primaryBorderColor: '#484848',
        lineColor: '#9e988e',
        secondaryColor: '#292929',
        tertiaryColor: '#1b1b1b',
        noteBkgColor: '#2b2b2b',
        noteTextColor: '#ebe6dc',
        noteBorderColor: '#484848',
        fontFamily,
      }
    : {
        background: '#f5f1e6',
        primaryColor: '#ebe5d5',
        primaryTextColor: '#242424',
        primaryBorderColor: '#c9c1ad',
        lineColor: '#6b655a',
        secondaryColor: '#efeae0',
        tertiaryColor: '#e4decb',
        noteBkgColor: '#f7f4eb',
        noteTextColor: '#242424',
        noteBorderColor: '#c9c1ad',
        fontFamily,
      };
}

function ensureMermaidInitialized(renderer: typeof mermaid, dark: boolean) {
  if (configuredDark === dark) return;
  configuredDark = dark;
  renderer.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: {
      darkMode: dark,
      ...readThemePalette(dark),
    },
  });
}

export function renderMermaidDiagram(source: string): Promise<MermaidRenderResult> {
  const trimmed = source.trim();
  if (!trimmed) {
    return Promise.resolve({ svg: '', error: null });
  }

  const run = async (): Promise<MermaidRenderResult> => {
    const renderId = `kanso-mermaid-${++renderCounter}`;
    try {
      const { default: mermaid } = await import('mermaid');
      ensureMermaidInitialized(mermaid, isDarkTheme());
      await mermaid.parse(trimmed);
      const { svg } = await mermaid.render(renderId, trimmed);
      cleanupMermaidErrorElements(renderId);
      return { svg, error: null };
    } catch (error) {
      cleanupMermaidErrorElements(renderId);
      const message = error instanceof Error ? error.message : 'Invalid Mermaid syntax';
      return { svg: null, error: message };
    }
  };

  const pending = renderQueue.then(run, run);
  renderQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

export function resetMermaidThemeCache() {
  configuredDark = null;
}
