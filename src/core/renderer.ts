import { remark } from "remark";
import html from "remark-html";
import gfm from "remark-gfm";
import slug from "remark-slug";
import autolinkHeadings from "remark-autolink-headings";
import emoji from "remark-emoji";
import { visit } from "unist-util-visit";

export interface RenderOptions {
  mermaidConfig?: Record<string, any>;
  sanitize?: boolean;
}

/**
 * Renders markdown content to HTML with Mermaid diagram support
 * @param markdown - The markdown content to render
 * @param options - Rendering options
 * @returns Rendered HTML string
 */
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = {}
): Promise<string> {
  const { sanitize = false } = options;

  const result = await remark()
    .use(gfm)
    .use(emoji)
    .use(slug as any)
    .use(autolinkHeadings as any)
    .use(() => (tree) => {
      visit(tree, "code", (node: any, index: number | null, parent: any) => {
        if (!parent || typeof index !== "number") return;

        // Handle mermaid code blocks
        if (node.lang === "mermaid") {
          parent.children[index] = {
            type: "html",
            value: `<div class="mermaid">${node.value}</div>`,
          };
          return;
        }

        // Handle regular code blocks with syntax highlighting
        const langClass = node.lang ? ` language-${node.lang}` : "";
        const escaped = String(node.value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        parent.children[index] = {
          type: "html",
          value: `<pre><code class="${langClass.trim()}">${escaped}</code></pre>`,
        };
      });
    })
    .use(html, { sanitize })
    .process(markdown);

  return result.toString();
}

/**
 * Extract mermaid blocks from markdown for pre-rendering
 * @param markdown - The markdown content
 * @returns Array of mermaid diagram code blocks
 */
export function extractMermaidBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(markdown))) {
    blocks.push(match[1].trim());
  }

  return blocks;
}
