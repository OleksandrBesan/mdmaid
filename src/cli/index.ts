#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative, extname, basename } from 'path';
import crypto from 'crypto';

interface CliArgs {
  command: string;
  input?: string;
  output?: string;
  port?: number;
  watch?: boolean;
  format?: 'html' | 'pdf';
  config?: string;
  manifest?: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {
    command: 'render', // default command
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case 'serve':
        parsed.command = 'serve';
        break;
      case 'render-diagrams':
        parsed.command = 'render-diagrams';
        break;
      case '-o':
      case '--output':
      case '--out':
        parsed.output = args[++i];
        break;
      case '-p':
      case '--port':
        parsed.port = parseInt(args[++i], 10);
        break;
      case '--watch':
      case '-w':
        parsed.watch = true;
        break;
      case '--format':
      case '-f':
        parsed.format = args[++i] as 'html' | 'pdf';
        break;
      case '--config':
      case '-c':
        parsed.config = args[++i];
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
        if (!arg.startsWith('-')) {
          parsed.input = arg;
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
  mdmaid serve <file.md>              Start dev server
  mdmaid serve <file.md> --watch      Watch for changes
  mdmaid render-diagrams <dir>        Render mermaid diagrams to SVG

Options:
  -o, --output <file>      Output file/directory path
  -p, --port <number>      Server port (default: 3333)
  -w, --watch              Watch for changes
  -f, --format <type>      Output format: html, pdf (default: html)
  -c, --config <file>      Config file (mdmaid.config.json)
  --manifest               Write manifest.json for caching
  -h, --help               Show help
  -v, --version            Show version

Examples:
  mdmaid README.md                          # Output to stdout
  mdmaid README.md -o output.html           # Save to file
  mdmaid serve docs/ --port 3000 --watch    # Live preview

  # Render mermaid diagrams to SVG (requires puppeteer)
  mdmaid render-diagrams _posts/ --out public/diagrams/ --manifest
  mdmaid render-diagrams _posts/ -c mdmaid.config.json --manifest

For Neovim integration, see: https://github.com/olesbesan/mdmaid.nvim
`);
}

function showVersion() {
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')
  );
  console.log(`mdmaid v${packageJson.version}`);
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
  const { renderMarkdown } = await import('../core/renderer');
  const { writeFileSync } = await import('fs');
  const { resolve } = await import('path');

  const inputPath = resolve(args.input!);
  const markdown = readFileSync(inputPath, 'utf-8');

  const html = await renderMarkdown(markdown);

  if (args.output) {
    const outputPath = resolve(args.output);

    // Wrap in basic HTML template
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rendered Markdown</title>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
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

async function serveCommand(args: CliArgs) {
  const { startServer } = await import('../server/index');

  if (!args.input) {
    console.error('Error: Input file required for serve command');
    console.error('Usage: mdmaid serve <file.md> [--watch] [--port PORT]');
    process.exit(1);
  }

  const options = {
    port: args.port, // undefined = dynamic port (OS assigns)
    watch: args.watch || false,
  };

  await startServer(args.input, options);
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
  const { extractMermaidBlocks } = await import('../core/renderer');
  const { renderMermaidBatch, closeBrowser } = await import('../core/mermaid-ssr');

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

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
