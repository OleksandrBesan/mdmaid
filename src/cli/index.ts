#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import crypto from 'crypto';

import type { MarkdownValidationResult } from '../core/validation.js';
import { sanitizeTerminalText } from '../tui/security.js';
import type { TuiBackend, TuiRenderOptions, TuiRenderResult } from '../tui/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

interface CliArgs {
  command: string;
  input?: string;
  inputs: string[];
  output?: string;
  port?: number;
  watch?: boolean;
  format?: string;
  config?: string;
  manifest?: boolean;
  backend?: string;
  viewer?: string;
  width?: number;
  color?: boolean;
  unicode?: boolean;
  json?: boolean;
  renderValidation?: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {
    command: 'render', // default command
    inputs: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const readOptionValue = (): string => {
      const value = args[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      return value;
    };

    switch (arg) {
      case 'serve':
        parsed.command = 'serve';
        break;
      case 'render-diagrams':
        parsed.command = 'render-diagrams';
        break;
      case 'show':
        parsed.command = 'show';
        break;
      case 'tui':
        parsed.command = 'tui';
        break;
      case 'render-mermaid':
        parsed.command = 'render-mermaid';
        break;
      case 'validate':
        parsed.command = 'validate';
        break;
      case '-o':
      case '--output':
      case '--out':
        parsed.output = readOptionValue();
        break;
      case '-p':
      case '--port':
        parsed.port = parseInt(readOptionValue(), 10);
        break;
      case '--watch':
      case '-w':
        parsed.watch = true;
        break;
      case '--format':
      case '-f':
        parsed.format = readOptionValue();
        break;
      case '--backend':
        parsed.backend = readOptionValue();
        break;
      case '--viewer':
        parsed.viewer = readOptionValue();
        break;
      case '--width':
        parsed.width = Number(readOptionValue());
        break;
      case '--color':
        parsed.color = true;
        break;
      case '--no-color':
        parsed.color = false;
        break;
      case '--unicode':
        parsed.unicode = true;
        break;
      case '--ascii':
        parsed.unicode = false;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--render':
        parsed.renderValidation = true;
        break;
      case '--config':
      case '-c':
        parsed.config = readOptionValue();
        break;
      case '--manifest':
        parsed.manifest = true;
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      case '--version':
      case '-v':
        showVersion();
        process.exit(0);
        break;
      default:
        if (arg === '-' || !arg.startsWith('-')) {
          parsed.inputs.push(arg);
          if (!parsed.input) {
            parsed.input = arg; // Keep first as primary for backwards compat
          }
        }
    }
  }

  return parsed;
}

function showHelp() {
  console.log(`
mdmaid - Markdown + Mermaid made simple

Usage:
  mdmaid <file.md>                    Render markdown to HTML (stdout)
  mdmaid <file.md> -o <output.html>   Render to file
  mdmaid show <file> --viewer <type>  Render with web, TUI, or auto viewer
  mdmaid tui <file|->                 Render Markdown for the terminal
  mdmaid render-mermaid <file|->      Render one Mermaid diagram as text
  mdmaid validate <file|->            Validate Markdown and Mermaid diagrams
  mdmaid serve <file.md>              Start dev server
  mdmaid serve <file.md> --watch      Watch for changes
  mdmaid render-diagrams <dir>        Render mermaid diagrams to SVG

Options:
  -o, --output <file>      Output file/directory path
  -p, --port <number>      Server port (default: 3333)
  -w, --watch              Watch for changes
  -f, --format <type>      Output format: html, pdf (default: html)
  --viewer <type>          Viewer: auto, tui, web (default: auto)
  --backend <type>         TUI backend: auto, veol, beautiful-mermaid, source
  --width <columns>        Terminal output width (20-1000)
  --color                  Force safe ANSI styling (unless NO_COLOR is set)
  --no-color               Disable ANSI styling
  --unicode                Use Unicode borders and symbols (default)
  --ascii                  Use portable ASCII borders and symbols
  --json                   Emit structured validation JSON
  --render                 Verify Mermaid in the browser during validation
  -c, --config <file>      Config file (mdmaid.config.json)
  --manifest               Write manifest.json for caching
  -h, --help               Show help
  -v, --version            Show version

Terminal rendering:
  auto tries Veol first, then the built-in rich Markdown renderer.
  The built-in renderer supports headings, inline styles, lists, quotes,
  tables, fenced code boxes, syntax highlighting, and Mermaid diagrams.
  Color is enabled for a TTY, disabled for redirected output, and NO_COLOR wins.
  Unknown code languages remain readable without highlighting; --ascii uses
  portable borders and symbols instead of Unicode box drawing.

Validation:
  validate checks every Mermaid fence with mdmaid's installed Mermaid parser.
  --render additionally launches the optional Puppeteer browser renderer.
  Exit codes: 0 valid, 1 invalid content, 2 validation runtime unavailable.

Examples:
  mdmaid README.md                          # Output to stdout
  mdmaid README.md -o output.html           # Save to file
  mdmaid tui README.md                      # Terminal Markdown + Mermaid
  cat README.md | mdmaid tui -              # Read Markdown from stdin
  mdmaid render-mermaid diagram.mmd --format ascii
  mdmaid validate README.md --json
  mdmaid validate README.md --render
  mdmaid serve docs/ --port 3000 --watch    # Live preview

  # Render mermaid diagrams to SVG (requires puppeteer)
  mdmaid render-diagrams _posts/ --out public/diagrams/ --manifest
  mdmaid render-diagrams _posts/ -c mdmaid.config.json --manifest

For Neovim integration, see: https://github.com/OleksandrBesan/mdmaid.nvim
`);
}

function showVersion() {
  const packageJson = readPackageMetadata();
  console.log(`mdmaid v${packageJson.version}`);
}

function readPackageMetadata(): {
  version: string;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'),
  );
}

function installedMermaidVersion(): string {
  const packageJson: { version?: string } = JSON.parse(
    readFileSync(require.resolve('mermaid/package.json'), 'utf8'),
  );
  if (!packageJson.version) {
    throw new Error('Unable to determine the installed Mermaid version.');
  }
  return packageJson.version;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input && args.command !== 'serve') {
    console.error('Error: Input file/directory required');
    console.error('Run "mdmaid --help" for usage');
    process.exit(1);
  }

  switch (args.command) {
    case 'render':
      await renderCommand(args);
      break;
    case 'show':
      await showCommand(args);
      break;
    case 'tui':
      await tuiCommand(args);
      break;
    case 'render-mermaid':
      await renderMermaidCommand(args);
      break;
    case 'validate':
      await validateCommand(args);
      break;
    case 'serve':
      await serveCommand(args);
      break;
    case 'render-diagrams':
      await renderDiagramsCommand(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      process.exit(1);
  }
}

async function renderCommand(args: CliArgs) {
  const { renderMarkdown } = await import('../core/renderer.js');
  const markdown = await readInput(args.input!);

  const html = await renderMarkdown(markdown);

  if (args.output) {
    const outputPath = resolve(args.output);
    const mermaidVersion = installedMermaidVersion();

    // Wrap in basic HTML template
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rendered Markdown</title>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@${mermaidVersion}/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: true, theme: 'default' });
  </script>
  <style>
    body {
      max-width: 800px;
      margin: 40px auto;
      padding: 0 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
    }
    pre {
      background: #f6f8fa;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
    }
    code {
      background: #f6f8fa;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
    }
    pre code {
      background: none;
      padding: 0;
    }
  </style>
</head>
<body>
${html}
</body>
</html>`;

    writeFileSync(outputPath, fullHtml);
    console.log(`✓ Rendered to: ${outputPath}`);
  } else {
    // Output to stdout
    console.log(html);
  }
}

const TUI_BACKENDS = new Set<TuiBackend>([
  'auto',
  'veol',
  'beautiful-mermaid',
  'source',
]);

function getTuiOptions(args: CliArgs): TuiRenderOptions {
  const backend = args.backend ?? 'auto';

  if (!TUI_BACKENDS.has(backend as TuiBackend)) {
    throw new Error(
      `Invalid backend "${backend}". Expected auto, veol, beautiful-mermaid, or source.`,
    );
  }

  if (
    args.width !== undefined &&
    (!Number.isInteger(args.width) || args.width < 20 || args.width > 1_000)
  ) {
    throw new Error('Invalid width. Expected an integer between 20 and 1000.');
  }

  return {
    backend: backend as TuiBackend,
    width: args.width,
    color:
      !('NO_COLOR' in process.env) &&
      (args.color ?? Boolean(process.stdout.isTTY)),
    unicode: args.unicode,
  };
}

async function readInput(input: string): Promise<string> {
  if (input !== '-') {
    return readFileSync(resolve(input), 'utf-8');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function writeTuiResult(result: TuiRenderResult): void {
  process.stdout.write(result.output);
  if (!result.output.endsWith('\n')) process.stdout.write('\n');

  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
}

async function tuiCommand(args: CliArgs): Promise<void> {
  const { renderMarkdownToTui } = await import('../tui/index.js');
  const markdown = await readInput(args.input!);
  const result = await renderMarkdownToTui(markdown, getTuiOptions(args));
  writeTuiResult(result);
}

async function renderMermaidCommand(args: CliArgs): Promise<void> {
  if (args.format !== undefined && args.format !== 'ascii') {
    throw new Error('Invalid format. render-mermaid currently supports only ascii.');
  }

  const { renderMermaidToAscii } = await import('../tui/index.js');
  const code = await readInput(args.input!);
  const result = await renderMermaidToAscii(code, getTuiOptions(args));
  writeTuiResult(result);
}

async function validateCommand(args: CliArgs): Promise<void> {
  const { validateMarkdown } = await import('../core/validation.js');
  const markdown = await readInput(args.input!);
  const result = await validateMarkdown(markdown, {
    mermaid: args.renderValidation ? 'render' : 'parse',
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeValidationText(result, args.input!);
  }

  process.exitCode = result.diagnostics.some(({ kind }) => kind === 'runtime')
    ? 2
    : result.valid
      ? 0
      : 1;
}

function writeValidationText(
  result: MarkdownValidationResult,
  input: string,
): void {
  const source = input === '-' ? 'stdin' : sanitizeTerminalText(input);
  if (result.valid) {
    const count = result.diagrams.length;
    const noun = count === 1 ? 'diagram' : 'diagrams';
    process.stdout.write(
      `✓ ${source}: valid (${count} Mermaid ${noun}, ${result.mode} mode)\n`,
    );
    return;
  }

  process.stdout.write(`✗ ${source}: validation failed\n`);
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.location
      ? `line ${diagnostic.location.start.line}, column ${diagnostic.location.start.column}`
      : 'document';
    const message = diagnostic.message.replace(/\s+/g, ' ').trim();
    process.stdout.write(
      `  ${location} ${diagnostic.code}: ${message}\n`,
    );
  }
}

function prefersTuiViewer(): boolean {
  return Boolean(
    process.stdout.isTTY ||
      process.env.SSH_CONNECTION ||
      process.env.SSH_TTY ||
      process.env.NVIM ||
      process.env.NVIM_LISTEN_ADDRESS ||
      process.env.TERM_PROGRAM === 'Termius'
  );
}

async function showCommand(args: CliArgs): Promise<void> {
  const viewer = args.viewer ?? 'auto';

  if (!['auto', 'tui', 'web'].includes(viewer)) {
    throw new Error(`Invalid viewer "${viewer}". Expected auto, tui, or web.`);
  }

  if (viewer === 'tui' || (viewer === 'auto' && prefersTuiViewer())) {
    await tuiCommand(args);
    return;
  }

  await renderCommand(args);
}

async function serveCommand(args: CliArgs) {
  const { startServer } = await import('../server/index.js');

  if (args.inputs.length === 0) {
    console.error('Error: Input file(s) required for serve command');
    console.error('Usage: mdmaid serve <file.md> [file2.md ...] [--watch] [--port PORT]');
    process.exit(1);
  }

  const options = {
    port: args.port, // undefined = dynamic port (OS assigns)
    watch: args.watch || false,
  };

  // Support multiple files
  const files = args.inputs.length === 1 ? args.inputs[0] : args.inputs;
  await startServer(files, options);
}

interface MdmaidConfig {
  fonts?: Array<{ family: string; path: string; weight?: number; style?: string }>;
  mermaid?: Record<string, any>;
  puppeteer?: Record<string, any>;
  embedFonts?: boolean;
}

function* walkDir(dir: string): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip node_modules, .git, and hidden directories
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile() && fullPath.endsWith('.md')) {
      yield fullPath;
    }
  }
}

function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

async function renderDiagramsCommand(args: CliArgs) {
  const { extractMermaidBlocks } = await import('../core/renderer.js');
  const { renderMermaidBatch, closeBrowser } = await import('../core/mermaid-ssr.js');

  if (!args.input) {
    console.error('Error: Input directory required');
    console.error('Usage: mdmaid render-diagrams <dir> --out <outdir> [--config <file>] [--manifest]');
    process.exit(1);
  }

  const inputDir = resolve(args.input);
  const outputDir = args.output ? resolve(args.output) : join(inputDir, 'diagrams');

  if (!existsSync(inputDir)) {
    console.error(`Error: Input directory not found: ${inputDir}`);
    process.exit(1);
  }

  // Load config
  let config: MdmaidConfig = {};
  if (args.config) {
    const configPath = resolve(args.config);
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } else {
      console.error(`Error: Config file not found: ${configPath}`);
      process.exit(1);
    }
  }

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Load manifest if exists
  const manifestPath = join(outputDir, 'manifest.json');
  let manifest: Record<string, Record<number, { hash: string; file: string }>> = {};
  if (args.manifest && existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = {};
    }
  }

  let totalRendered = 0;
  let totalSkipped = 0;

  // Process all markdown files
  for (const mdPath of walkDir(inputDir)) {
    const relPath = relative(inputDir, mdPath).replace(/\\/g, '/').replace(/\.md$/, '');
    const slugId = relPath.replace(/[\/\\]/g, '-');

    const markdown = readFileSync(mdPath, 'utf-8');
    const blocks = extractMermaidBlocks(markdown);

    if (blocks.length === 0) continue;

    // Check which blocks need rendering
    const toRender: Array<{ index: number; code: string; hash: string }> = [];

    for (let i = 0; i < blocks.length; i++) {
      const idx = i + 1;
      const hash = hashContent(blocks[i]);
      const outFile = join(outputDir, `${slugId}-${idx}.svg`);
      const prevHash = manifest[slugId]?.[idx]?.hash;

      if (existsSync(outFile) && prevHash === hash) {
        console.log(`  skip ${slugId}-${idx}: unchanged`);
        totalSkipped++;
      } else {
        toRender.push({ index: idx, code: blocks[i], hash });
      }
    }

    if (toRender.length === 0) continue;

    console.log(`\nProcessing: ${relPath} (${toRender.length} diagram(s))`);

    // Batch render
    const svgs = await renderMermaidBatch(
      toRender.map((b) => b.code),
      {
        fonts: config.fonts,
        mermaid: config.mermaid,
        puppeteer: config.puppeteer,
        embedFonts: config.embedFonts ?? true,
      }
    );

    // Write SVGs
    for (let i = 0; i < toRender.length; i++) {
      const { index, hash } = toRender[i];
      const svg = svgs[i];
      const outFile = join(outputDir, `${slugId}-${index}.svg`);

      if (svg.startsWith('<svg')) {
        writeFileSync(outFile, svg);
        console.log(`  ✓ ${slugId}-${index}.svg`);

        // Update manifest
        if (!manifest[slugId]) manifest[slugId] = {};
        manifest[slugId][index] = { hash, file: `${slugId}-${index}.svg` };
        totalRendered++;
      } else {
        console.error(`  ✗ ${slugId}-${index}: ${svg}`);
      }
    }
  }

  // Close browser
  await closeBrowser();

  // Write manifest
  if (args.manifest) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  console.log(`\nDone: ${totalRendered} rendered, ${totalSkipped} skipped`);
}
