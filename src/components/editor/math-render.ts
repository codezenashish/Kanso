import katex from 'katex';

type LatexRenderResult = {
  html: string;
  error: string | null;
};

export function renderLatex(latex: string, displayMode: boolean): LatexRenderResult {
  if (!latex.trim()) return { html: '', error: null };
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: true,
      strict: false,
      trust: false,
    });
    return { html, error: null };
  } catch (caughtError) {
    const message = caughtError instanceof Error
      ? caughtError.message.replace(/^KaTeX parse error:\s*/i, '')
      : 'Invalid LaTeX expression';
    return { html: '', error: message };
  }
}

export function renderMathElement(container: HTMLElement, latex: string, displayMode: boolean) {
  const { html, error } = renderLatex(latex, displayMode);
  container.setAttribute('data-latex', latex);

  if (!latex.trim()) {
    container.removeAttribute('data-math-error');
    container.title = displayMode ? 'Click to edit equation' : 'Click to edit inline math';
    const placeholder = container.ownerDocument.createElement('span');
    placeholder.className = 'math-empty';
    placeholder.textContent = displayMode ? 'Click to add equation ($$…$$)' : '$…$';
    container.replaceChildren(placeholder);
    return;
  }

  if (error) {
    container.setAttribute('data-math-error', 'true');
    container.title = error;
    const errorBox = container.ownerDocument.createElement('span');
    errorBox.className = 'math-error';

    const source = container.ownerDocument.createElement('span');
    source.className = 'math-error-source';
    source.textContent = displayMode ? `$$ ${latex} $$` : `$${latex}$`;
    errorBox.append(source);

    if (displayMode) {
      const detail = container.ownerDocument.createElement('span');
      detail.className = 'math-error-detail';
      detail.textContent = error;
      errorBox.append(detail);
    }

    container.replaceChildren(errorBox);
    return;
  }

  container.removeAttribute('data-math-error');
  container.title = displayMode ? 'Click to edit equation' : `Click to edit: $${latex}$`;
  container.innerHTML = html;
}
