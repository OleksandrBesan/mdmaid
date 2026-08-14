import type { Code } from 'mdast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

import type { MermaidSSROptions } from './mermaid-ssr.js';
import { sanitizeTerminalText } from '../tui/security.js';

const DEFAULT_MAX_MARKDOWN_CHARACTERS = 5_000_000;
const DEFAULT_MAX_DIAGRAM_CHARACTERS = 200_000;
const DEFAULT_MAX_DIAGRAMS = 100;
const MAX_DIAGNOSTIC_CHARACTERS = 4_000;

export type ValidationMode = 'parse' | 'render';
export type ValidationKind = 'content' | 'runtime';
export type ValidationSeverity = 'error' | 'warning';
export type ValidationStage = 'markdown' | 'parse' | 'render';

export interface ValidationPoint {
  line: number;
  column: number;
}

export interface ValidationLocation {
  start: ValidationPoint;
  end: ValidationPoint;
}

export interface ValidationDiagnostic {
  code: string;
  severity: ValidationSeverity;
  kind: ValidationKind;
  stage: ValidationStage;
  message: string;
  diagramIndex?: number;
  location?: ValidationLocation;
}

export interface MermaidValidationResult {
  index: number;
  diagramType: string;
  location: ValidationLocation;
  valid: boolean;
  parsed: boolean;
  rendered: boolean | null;
  diagnostics: ValidationDiagnostic[];
}

export interface MarkdownValidationResult {
  valid: boolean;
  mode: ValidationMode;
  markdown: {
    valid: boolean;
  };
  diagrams: MermaidValidationResult[];
  diagnostics: ValidationDiagnostic[];
}

export interface ValidateMarkdownOptions {
  mermaid?: ValidationMode;
  maxMarkdownCharacters?: number;
  maxDiagramCharacters?: number;
  maxDiagrams?: number;
  renderOptions?: MermaidSSROptions;
}

interface MermaidParseResult {
  diagramType: string;
}

export interface ValidationAdapters {
  parse: (code: string) => Promise<MermaidParseResult>;
  renderBatch: (
    codes: readonly string[],
    options: MermaidSSROptions,
  ) => Promise<readonly string[]>;
}

interface DiagramSource {
  code: string;
  contentStartLine: number;
  index: number;
  location: ValidationLocation;
}

const defaultAdapters: ValidationAdapters = {
  async parse(code) {
    const { parseMermaidSyntax } = await import('./mermaid-parser.js');
    return parseMermaidSyntax(code);
  },
  async renderBatch(codes, options) {
    const { closeBrowser, renderMermaidBatch } = await import(
      './mermaid-ssr.js'
    );

    try {
      return await renderMermaidBatch([...codes], {
        ...options,
        allowExternalResources: false,
        mermaid: {
          ...options.mermaid,
          securityLevel: 'strict',
          startOnLoad: false,
        },
      });
    } finally {
      await closeBrowser().catch(() => undefined);
    }
  },
};

export async function validateMarkdown(
  markdown: string,
  options: ValidateMarkdownOptions = {},
): Promise<MarkdownValidationResult> {
  return validateMarkdownWithAdapters(markdown, options, defaultAdapters);
}

export async function validateMermaid(
  code: string,
  options: Omit<ValidateMarkdownOptions, 'maxMarkdownCharacters' | 'maxDiagrams'> = {},
): Promise<MermaidValidationResult> {
  const lines = normalizeLines(code);
  const source: DiagramSource = {
    code,
    contentStartLine: 0,
    index: 0,
    location: {
      start: { line: 1, column: 1 },
      end: {
        line: lines.length,
        column: (lines.at(-1)?.length ?? 0) + 1,
      },
    },
  };
  const { diagrams } = await validateDiagramSources(
    [source],
    options,
    defaultAdapters,
  );

  return diagrams[0];
}

/** @internal Exported for deterministic adapter-level tests. */
export async function validateMarkdownWithAdapters(
  markdown: string,
  options: ValidateMarkdownOptions = {},
  adapters: ValidationAdapters = defaultAdapters,
): Promise<MarkdownValidationResult> {
  const mode = resolveMode(options.mermaid);
  const diagnostics: ValidationDiagnostic[] = [];
  const markdownLimit = resolveLimit(
    options.maxMarkdownCharacters,
    DEFAULT_MAX_MARKDOWN_CHARACTERS,
  );

  if (markdown.length > markdownLimit) {
    diagnostics.push({
      code: 'MARKDOWN_SIZE_LIMIT',
      severity: 'error',
      kind: 'content',
      stage: 'markdown',
      message: safeMessage(
        `Markdown contains ${markdown.length} characters; the validation limit is ${markdownLimit}.`,
      ),
      location: pointLocation(1, 1),
    });
    return {
      valid: false,
      mode,
      markdown: { valid: false },
      diagrams: [],
      diagnostics,
    };
  }

  const tree = remark().use(remarkGfm).parse(markdown);
  const lines = normalizeLines(markdown);
  const codeNodes: Code[] = [];

  visit(tree, 'code', (node: Code) => {
    codeNodes.push(node);
    const unclosed = findUnclosedFence(node, lines);
    if (unclosed) diagnostics.push(unclosed);
  });

  const sources = codeNodes
    .filter((node) => node.lang?.trim().toLowerCase() === 'mermaid')
    .map((node, index) => diagramSourceFromNode(node, index));
  const diagramLimit = resolveLimit(options.maxDiagrams, DEFAULT_MAX_DIAGRAMS);

  if (sources.length > diagramLimit) {
    diagnostics.push({
      code: 'MERMAID_DIAGRAM_LIMIT',
      severity: 'error',
      kind: 'content',
      stage: 'markdown',
      message: safeMessage(
        `Markdown contains ${sources.length} Mermaid diagrams; the validation limit is ${diagramLimit}.`,
      ),
      location: sources[diagramLimit]?.location ?? pointLocation(1, 1),
    });
  }

  const validated = await validateDiagramSources(
    sources.slice(0, diagramLimit),
    options,
    adapters,
  );
  diagnostics.push(...validated.diagnostics);
  const markdownValid = !diagnostics.some(
    ({ severity, stage }) => severity === 'error' && stage === 'markdown',
  );

  return {
    valid: !diagnostics.some(({ severity }) => severity === 'error'),
    mode,
    markdown: { valid: markdownValid },
    diagrams: validated.diagrams,
    diagnostics,
  };
}

async function validateDiagramSources(
  sources: readonly DiagramSource[],
  options: Omit<ValidateMarkdownOptions, 'maxMarkdownCharacters' | 'maxDiagrams'>,
  adapters: ValidationAdapters,
): Promise<{
  diagrams: MermaidValidationResult[];
  diagnostics: ValidationDiagnostic[];
}> {
  const mode = resolveMode(options.mermaid);
  const diagramLimit = resolveLimit(
    options.maxDiagramCharacters,
    DEFAULT_MAX_DIAGRAM_CHARACTERS,
  );
  const diagrams: MermaidValidationResult[] = sources.map((source) => ({
    index: source.index,
    diagramType: declaredDiagramType(source.code),
    location: source.location,
    valid: false,
    parsed: false,
    rendered: null,
    diagnostics: [],
  }));
  const diagnostics: ValidationDiagnostic[] = [];

  for (const source of sources) {
    const diagram = diagrams[source.index];

    if (source.code.length > diagramLimit) {
      addDiagramDiagnostic(diagram, diagnostics, {
        code: 'MERMAID_SIZE_LIMIT',
        severity: 'error',
        kind: 'content',
        stage: 'parse',
        message: safeMessage(
          `Mermaid diagram contains ${source.code.length} characters; the validation limit is ${diagramLimit}.`,
        ),
        diagramIndex: source.index,
        location: source.location,
      });
      continue;
    }

    try {
      const parsed = await adapters.parse(source.code);
      diagram.diagramType = parsed.diagramType || diagram.diagramType;
      diagram.parsed = true;
      diagram.valid = mode === 'parse';
    } catch (error) {
      addDiagramDiagnostic(
        diagram,
        diagnostics,
        parseErrorDiagnostic(error, source),
      );
    }
  }

  if (mode === 'render') {
    const renderableSources = sources.filter(
      (source) => diagrams[source.index].parsed,
    );

    if (renderableSources.length > 0) {
      try {
        const results = await adapters.renderBatch(
          renderableSources.map(({ code }) => code),
          options.renderOptions ?? {},
        );

        if (results.length !== renderableSources.length) {
          throw new Error(
            `Browser renderer returned ${results.length} results for ${renderableSources.length} diagrams.`,
          );
        }

        for (const [resultIndex, source] of renderableSources.entries()) {
          const diagram = diagrams[source.index];
          const output = results[resultIndex]?.trimStart() ?? '';

          if (output.startsWith('<svg')) {
            diagram.rendered = true;
            diagram.valid = true;
            continue;
          }

          diagram.rendered = false;
          addDiagramDiagnostic(diagram, diagnostics, {
            code: 'MERMAID_RENDER_ERROR',
            severity: 'error',
            kind: 'content',
            stage: 'render',
            message: safeMessage(output.replace(/^Error:\s*/i, '') || 'Mermaid did not return SVG output.'),
            diagramIndex: source.index,
            location: source.location,
          });
        }
      } catch (error) {
        const runtimeDiagnostic: ValidationDiagnostic = {
          code: 'MERMAID_RENDER_RUNTIME_ERROR',
          severity: 'error',
          kind: 'runtime',
          stage: 'render',
          message: safeMessage(errorMessage(error)),
        };
        diagnostics.push(runtimeDiagnostic);
        for (const source of renderableSources) {
          diagrams[source.index].diagnostics.push(runtimeDiagnostic);
        }
      }
    }
  }

  return { diagrams, diagnostics };
}

function parseErrorDiagnostic(
  error: unknown,
  source: DiagramSource,
): ValidationDiagnostic {
  const value = error as {
    hash?: {
      line?: number;
      loc?: {
        first_line?: number;
        last_line?: number;
        first_column?: number;
        last_column?: number;
      };
    };
  };
  const match = /^\s*(?:lexical|parse) error on line\s+(\d+)/i.exec(
    errorMessage(error),
  );
  const firstLine = positiveInteger(
    value?.hash?.loc?.first_line ?? value?.hash?.line ?? Number(match?.[1]),
    1,
  );
  const lastLine = positiveInteger(value?.hash?.loc?.last_line, firstLine);
  const firstColumn = nonnegativeInteger(value?.hash?.loc?.first_column, 0) + 1;
  const lastColumn = nonnegativeInteger(
    value?.hash?.loc?.last_column,
    firstColumn - 1,
  ) + 1;

  if (!isMermaidContentError(error)) {
    return {
      code: 'MERMAID_PARSE_RUNTIME_ERROR',
      severity: 'error',
      kind: 'runtime',
      stage: 'parse',
      message: safeMessage(errorMessage(error)),
      diagramIndex: source.index,
      location: source.location,
    };
  }

  return {
    code: 'MERMAID_PARSE_ERROR',
    severity: 'error',
    kind: 'content',
    stage: 'parse',
    message: safeMessage(errorMessage(error)),
    diagramIndex: source.index,
    location: {
      start: {
        line: source.contentStartLine + firstLine,
        column: firstColumn,
      },
      end: {
        line: source.contentStartLine + lastLine,
        column: lastColumn,
      },
    },
  };
}

function isMermaidContentError(error: unknown): boolean {
  const value = error as { hash?: unknown; message?: unknown; name?: unknown };
  if (value?.hash !== undefined) return true;
  if (value?.name === 'UnknownDiagramError') return true;
  return /^\s*(?:lexical|parse) error\b/i.test(errorMessage(error));
}

function diagramSourceFromNode(node: Code, index: number): DiagramSource {
  const position = node.position;
  return {
    code: node.value,
    contentStartLine: position?.start.line ?? 1,
    index,
    location: position
      ? {
          start: {
            line: position.start.line,
            column: position.start.column,
          },
          end: {
            line: position.end.line,
            column: position.end.column,
          },
        }
      : pointLocation(1, 1),
  };
}

function findUnclosedFence(
  node: Code,
  lines: readonly string[],
): ValidationDiagnostic | null {
  const startLine = node.position?.start.line;
  if (!startLine) return null;
  const opener = /^ {0,3}(`{3,}|~{3,})/.exec(lines[startLine - 1] ?? '');
  if (!opener) return null;
  const marker = opener[1][0];
  const minimumLength = opener[1].length;
  const lastLine = node.position?.end.line ?? lines.length;

  for (let line = startLine + 1; line <= lastLine; line++) {
    const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(lines[line - 1] ?? '');
    if (
      closing &&
      closing[1][0] === marker &&
      closing[1].length >= minimumLength
    ) {
      return null;
    }
  }

  return {
    code: 'MARKDOWN_UNCLOSED_FENCE',
    severity: 'error',
    kind: 'content',
    stage: 'markdown',
    message: `Fenced code block opened on line ${startLine} is not closed.`,
    location: pointLocation(startLine, node.position?.start.column ?? 1),
  };
}

function addDiagramDiagnostic(
  diagram: MermaidValidationResult,
  all: ValidationDiagnostic[],
  diagnostic: ValidationDiagnostic,
): void {
  diagram.valid = false;
  diagram.diagnostics.push(diagnostic);
  all.push(diagnostic);
}

function safeMessage(value: string): string {
  const safe = sanitizeTerminalText(value).trim();
  return safe.length <= MAX_DIAGNOSTIC_CHARACTERS
    ? safe
    : `${safe.slice(0, MAX_DIAGNOSTIC_CHARACTERS - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveMode(mode: ValidationMode | undefined): ValidationMode {
  return mode === 'render' ? 'render' : 'parse';
}

function resolveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonnegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

function pointLocation(line: number, column: number): ValidationLocation {
  return {
    start: { line, column },
    end: { line, column },
  };
}

function normalizeLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n');
}

function declaredDiagramType(code: string): string {
  return code.trimStart().split(/[\s;]/, 1)[0] || 'unknown';
}
