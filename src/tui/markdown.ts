import { remark } from 'remark';
import { visit } from 'unist-util-visit';

import type { TuiRenderResult } from './types.js';

interface MermaidBlock {
  code: string;
  end: number;
  start: number;
}

interface CodeNode {
  lang?: string | null;
  value: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

function findMermaidBlocks(markdown: string): MermaidBlock[] {
  const tree = remark().parse(markdown);
  const blocks: MermaidBlock[] = [];

  visit(tree, 'code', (node: CodeNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;

    if (
      node.lang?.toLowerCase() === 'mermaid' &&
      typeof start === 'number' &&
      typeof end === 'number'
    ) {
      blocks.push({ code: node.value, start, end });
    }
  });

  return blocks.sort((left, right) => left.start - right.start);
}

export async function renderMarkdownMermaidFallback(
  markdown: string,
  renderMermaid: (code: string) => Promise<TuiRenderResult>,
): Promise<TuiRenderResult> {
  const blocks = findMermaidBlocks(markdown);

  if (blocks.length === 0) {
    return {
      output: markdown,
      backend: 'source',
      warnings: [],
    };
  }

  const output: string[] = [];
  const warnings: string[] = [];
  let cursor = 0;
  let rendered = false;

  for (const block of blocks) {
    output.push(markdown.slice(cursor, block.start));
    const result = await renderMermaid(block.code);
    warnings.push(...result.warnings);

    if (result.backend === 'beautiful-mermaid') {
      output.push(result.output);
      rendered = true;
    } else {
      output.push(markdown.slice(block.start, block.end));
    }

    cursor = block.end;
  }

  output.push(markdown.slice(cursor));

  return {
    output: output.join(''),
    backend: rendered ? 'beautiful-mermaid' : 'source',
    warnings,
  };
}
