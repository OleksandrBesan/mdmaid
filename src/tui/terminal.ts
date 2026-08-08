import { Chalk, type ChalkInstance } from 'chalk';
import type { Element, Nodes as HastNode, Root as HastRoot } from 'hast';
import { common, createLowlight } from 'lowlight';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

export const DEFAULT_TERMINAL_WIDTH = 80;
const MAX_TERMINAL_WIDTH = 1_000;
const MAX_HIGHLIGHT_CHARS = 200_000;

const lowlight = createLowlight(common);

export interface TerminalTheme {
  color: boolean;
  styles: ChalkInstance;
}

export function createTerminalTheme(color: boolean): TerminalTheme {
  return {
    color,
    styles: new Chalk({ level: color ? 1 : 0 }),
  };
}

export function resolveTerminalWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) {
    return DEFAULT_TERMINAL_WIDTH;
  }

  return Math.min(MAX_TERMINAL_WIDTH, Math.max(1, Math.floor(width)));
}

export function wrapTerminalText(
  value: string,
  width: number,
  options: { trim?: boolean; wordWrap?: boolean } = {},
): string[] {
  const columns = Math.max(1, width);
  const trim = options.trim ?? true;
  const wordWrap = options.wordWrap ?? true;
  const sourceLines = value.replace(/\r\n?/g, '\n').split('\n');
  const lines: string[] = [];

  for (const sourceLine of sourceLines) {
    const wrapped = wrapAnsi(sourceLine, columns, {
      hard: true,
      trim,
      wordWrap,
    });
    lines.push(...wrapped.split('\n'));
  }

  return lines.length > 0 ? lines : [''];
}

export function fitTerminalLines(value: string, width: number): string[] {
  return wrapTerminalText(value, width, { trim: false, wordWrap: false });
}

export function padTerminalText(
  value: string,
  width: number,
  alignment: 'center' | 'left' | 'right' = 'left',
): string {
  const missing = Math.max(0, width - stringWidth(value));

  if (alignment === 'right') return `${' '.repeat(missing)}${value}`;
  if (alignment === 'center') {
    const left = Math.floor(missing / 2);
    return `${' '.repeat(left)}${value}${' '.repeat(missing - left)}`;
  }

  return `${value}${' '.repeat(missing)}`;
}

export function truncateTerminalText(value: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(value) <= width) return value;
  return wrapTerminalText(value, width, {
    trim: false,
    wordWrap: false,
  })[0] ?? '';
}

export function highlightTerminalCode(
  code: string,
  language: string | null | undefined,
  theme: TerminalTheme,
): { highlighted: boolean; output: string } {
  const normalizedLanguage = language?.trim().toLowerCase();

  if (
    !theme.color ||
    !normalizedLanguage ||
    code.length > MAX_HIGHLIGHT_CHARS ||
    !lowlight.registered(normalizedLanguage)
  ) {
    return { highlighted: false, output: code };
  }

  try {
    const tree = lowlight.highlight(normalizedLanguage, code);
    return {
      highlighted: true,
      output: renderHighlightTree(tree, theme.styles),
    };
  } catch {
    return { highlighted: false, output: code };
  }
}

function renderHighlightTree(tree: HastRoot, styles: ChalkInstance): string {
  return tree.children.map((node) => renderHighlightNode(node, styles)).join('');
}

function renderHighlightNode(node: HastNode, styles: ChalkInstance): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return '';

  const value = node.children
    .map((child) => renderHighlightNode(child, styles))
    .join('');
  return applyHighlightClass(value, node, styles);
}

function applyHighlightClass(
  value: string,
  node: Element,
  styles: ChalkInstance,
): string {
  const classes = Array.isArray(node.properties.className)
    ? node.properties.className.map(String)
    : [];
  const token = classes.find((className) => className.startsWith('hljs-')) ?? '';

  if (/comment|quote/.test(token)) return styles.gray(value);
  if (/keyword|operator|selector-tag/.test(token)) return styles.magenta(value);
  if (/string|regexp|attribute|template/.test(token)) return styles.green(value);
  if (/number|literal/.test(token)) return styles.yellow(value);
  if (/title|section|type/.test(token)) return styles.blue(value);
  if (/built_in|builtin-name|symbol|bullet|name/.test(token)) {
    return styles.cyan(value);
  }
  if (/meta|doctag/.test(token)) return styles.gray(value);

  return value;
}
