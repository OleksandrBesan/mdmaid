import { renderWithBeautifulMermaid } from './backends/beautiful-mermaid.js';
import {
  renderMarkdownSource,
  renderMermaidSource,
} from './backends/source.js';
import { renderWithVeol } from './backends/veol.js';
import { renderMarkdownMermaidFallback } from './markdown.js';
import type { TuiRenderOptions, TuiRenderResult } from './types.js';

export type { TuiBackend, TuiRenderOptions, TuiRenderResult } from './types.js';

export async function renderMarkdownToTui(
  markdown: string,
  options: TuiRenderOptions = {},
): Promise<TuiRenderResult> {
  const backend = options.backend ?? 'auto';
  const warnings: string[] = [];

  if (backend === 'auto' || backend === 'veol') {
    const result = await renderWithVeol(markdown, options);

    if (result.output !== undefined) {
      return {
        output: result.output,
        backend: 'veol',
        warnings,
      };
    }

    if (result.warning) warnings.push(result.warning);
    if (backend === 'veol') return renderMarkdownSource(markdown, warnings);
  }

  if (
    backend === 'beautiful-mermaid' ||
    (backend === 'auto' && options.beautifulMermaid !== false)
  ) {
    const result = await renderMarkdownMermaidFallback(markdown, (code) =>
      renderMermaidWithBeautifulFallback(code, options),
    );

    return {
      ...result,
      warnings: [...warnings, ...result.warnings],
    };
  }

  return renderMarkdownSource(markdown, warnings);
}

export async function renderMermaidToAscii(
  code: string,
  options: TuiRenderOptions = {},
): Promise<TuiRenderResult> {
  const backend = options.backend ?? 'auto';
  const warnings: string[] = [];

  if (backend === 'auto' || backend === 'veol') {
    const source = renderMermaidSource(code).output;
    const result = await renderWithVeol(`${source}\n`, options);

    if (result.output !== undefined) {
      return {
        output: result.output,
        backend: 'veol',
        warnings,
      };
    }

    if (result.warning) warnings.push(result.warning);
    if (backend === 'veol') return renderMermaidSource(code, warnings);
  }

  if (
    backend === 'beautiful-mermaid' ||
    (backend === 'auto' && options.beautifulMermaid !== false)
  ) {
    const result = await renderMermaidWithBeautifulFallback(code, options);

    if (result.backend === 'beautiful-mermaid') {
      return {
        ...result,
        warnings: [...warnings, ...result.warnings],
      };
    }

    warnings.push(...result.warnings);
  }

  return renderMermaidSource(code, warnings);
}

async function renderMermaidWithBeautifulFallback(
  code: string,
  options: TuiRenderOptions,
): Promise<TuiRenderResult> {
  const result = await renderWithBeautifulMermaid(code, options);

  if (result.output !== undefined) {
    return {
      output: result.output,
      backend: 'beautiful-mermaid',
      warnings: [],
    };
  }

  return renderMermaidSource(code, result.warning ? [result.warning] : []);
}
