import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DocumentSnapshot {
  path: string;
  content: string;
  hash: string;
  mtimeMs: number;
}

export interface MermaidBlock {
  index: number;
  id?: string;
  type?: string;
  startLine: number;
  endLine: number;
  fenceStartOffset: number;
  fenceEndOffset: number;
  code: string;
  meta: Record<string, string>;
}

export interface WriteGuard {
  expectedHash: string;
  expectedMtimeMs?: number;
}

export class DocumentConflictError extends Error {
  constructor(message = 'Document changed since it was loaded') {
    super(message);
    this.name = 'DocumentConflictError';
  }
}

interface LineRecord {
  content: string;
  offset: number;
  raw: string;
}

function getLines(markdown: string): LineRecord[] {
  const lines: LineRecord[] = [];
  const regex = /.*(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const raw = match[0];
    if (raw === '') break;
    const content = raw.replace(/\r?\n$/, '');
    lines.push({ content, offset: match.index, raw });
  }

  return lines;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function readDocument(path: string): DocumentSnapshot {
  const absolutePath = resolve(path);
  const content = readFileSync(absolutePath, 'utf8');
  const stat = statSync(absolutePath);

  return {
    path: absolutePath,
    content,
    hash: hashContent(content),
    mtimeMs: stat.mtimeMs,
  };
}

export function parseMdmaidDirective(line: string): Record<string, string> {
  const match = line.trim().match(/^%%\s+mdmaid:diagram\s+(.+)$/);
  if (!match) return {};

  const meta: Record<string, string> = {};
  const pairs = match[1].matchAll(/([A-Za-z0-9_-]+)=("[^"]*"|'[^']*'|[^\s]+)/g);
  for (const pair of pairs) {
    const value = pair[2];
    meta[pair[1]] = value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return meta;
}

export function serializeMdmaidDirective(meta: Record<string, string>): string {
  const orderedKeys = ['id', 'type', 'version'];
  const keys = [
    ...orderedKeys.filter((key) => meta[key] !== undefined),
    ...Object.keys(meta).filter((key) => !orderedKeys.includes(key)).sort(),
  ];

  const attrs = keys.map((key) => `${key}=${String(meta[key])}`).join(' ');
  return `%% mdmaid:diagram${attrs ? ` ${attrs}` : ''}`;
}

export function findMermaidBlocks(markdown: string): MermaidBlock[] {
  const lines = getLines(markdown);
  const blocks: MermaidBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const start = lines[i];
    if (!/^\s*```mermaid\b/.test(start.content)) continue;

    for (let j = i + 1; j < lines.length; j++) {
      const end = lines[j];
      if (!/^\s*```\s*$/.test(end.content)) continue;

      const rawCodeLines = lines.slice(i + 1, j).map((line) => line.content);
      let meta: Record<string, string> = {};
      let codeLines = rawCodeLines;

      if (rawCodeLines.length > 0) {
        const parsed = parseMdmaidDirective(rawCodeLines[0]);
        if (Object.keys(parsed).length > 0) {
          meta = parsed;
          codeLines = rawCodeLines.slice(1);
        }
      }

      blocks.push({
        index: blocks.length,
        id: meta.id,
        type: meta.type,
        startLine: i + 1,
        endLine: j + 1,
        fenceStartOffset: start.offset,
        fenceEndOffset: end.offset + end.content.length,
        code: codeLines.join('\n'),
        meta,
      });

      i = j;
      break;
    }
  }

  return blocks;
}

export function replaceMermaidBlock(
  markdown: string,
  blockIndex: number,
  newCode: string,
  meta?: Record<string, string>
): string {
  const block = findMermaidBlocks(markdown).find((candidate) => candidate.index === blockIndex);
  if (!block) {
    throw new RangeError(`Mermaid block ${blockIndex} not found`);
  }

  const normalizedCode = newCode.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const replacementLines = ['```mermaid'];
  if (meta && Object.keys(meta).length > 0) {
    replacementLines.push(serializeMdmaidDirective(meta));
  }
  if (normalizedCode.length > 0) {
    replacementLines.push(...normalizedCode.split('\n'));
  }
  replacementLines.push('```');

  return [
    markdown.slice(0, block.fenceStartOffset),
    replacementLines.join('\n'),
    markdown.slice(block.fenceEndOffset),
  ].join('');
}

export function appendMermaidBlock(
  markdown: string,
  newCode: string,
  meta?: Record<string, string>
): string {
  const normalizedCode = newCode.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const blockLines = ['```mermaid'];
  if (meta && Object.keys(meta).length > 0) {
    blockLines.push(serializeMdmaidDirective(meta));
  }
  if (normalizedCode.length > 0) {
    blockLines.push(...normalizedCode.split('\n'));
  }
  blockLines.push('```');

  const prefix = markdown.length === 0
    ? ''
    : markdown.endsWith('\n\n')
      ? markdown
      : markdown.endsWith('\n')
        ? `${markdown}\n`
        : `${markdown}\n\n`;

  return `${prefix}${blockLines.join('\n')}\n`;
}

export function writeDocumentIfUnchanged(
  path: string,
  nextContent: string,
  guard: WriteGuard
): DocumentSnapshot {
  const current = readDocument(path);
  if (current.hash !== guard.expectedHash) {
    throw new DocumentConflictError();
  }
  if (guard.expectedMtimeMs !== undefined && current.mtimeMs !== guard.expectedMtimeMs) {
    throw new DocumentConflictError();
  }

  writeFileSync(current.path, nextContent, 'utf8');
  return readDocument(current.path);
}
