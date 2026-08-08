import type { TuiRenderResult } from '../types.js';
import { sanitizeTerminalText } from '../security.js';

export function renderMarkdownSource(
  markdown: string,
  warnings: string[] = [],
): TuiRenderResult {
  return {
    output: sanitizeTerminalText(markdown),
    backend: 'source',
    warnings,
  };
}

export function renderMermaidSource(
  code: string,
  warnings: string[] = [],
): TuiRenderResult {
  const safeCode = sanitizeTerminalText(code);
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(safeCode.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  const newline = safeCode.endsWith('\n') ? '' : '\n';

  return {
    output: `${fence}mermaid\n${safeCode}${newline}${fence}`,
    backend: 'source',
    warnings,
  };
}
