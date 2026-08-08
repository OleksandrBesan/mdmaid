import type { TuiRenderOptions } from '../types.js';

export interface BeautifulMermaidAttempt {
  output?: string;
  warning?: string;
}

export async function renderWithBeautifulMermaid(
  code: string,
  options: TuiRenderOptions,
): Promise<BeautifulMermaidAttempt> {
  try {
    const { renderMermaidASCII } = await import('beautiful-mermaid');
    const output = renderMermaidASCII(code, {
      useAscii: options.unicode === false,
      colorMode: 'none',
    });

    if (!output.trim()) {
      return {
        warning: 'beautiful-mermaid returned empty output.',
      };
    }

    return { output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      warning: `beautiful-mermaid could not render the diagram: ${message}`,
    };
  }
}
