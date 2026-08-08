import type { TuiRenderResult } from '../types.js';

export function renderMarkdownSource(
  markdown: string,
  warnings: string[] = [],
): TuiRenderResult {
  return {
    output: markdown,
    backend: 'source',
    warnings,
  };
}

export function renderMermaidSource(
  code: string,
  warnings: string[] = [],
): TuiRenderResult {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(code.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  const newline = code.endsWith('\n') ? '' : '\n';

  return {
    output: `${fence}mermaid\n${code}${newline}${fence}`,
    backend: 'source',
    warnings,
  };
}
