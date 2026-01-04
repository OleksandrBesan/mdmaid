import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Puppeteer is optional - only loaded when SSR is used
let pptr: any = null;

export interface FontConfig {
  family: string;
  /** Local file path to font (woff2, woff, ttf, otf) */
  path?: string;
  /** External URL (Google Fonts CSS, CDN link) */
  url?: string;
  weight?: number;
  style?: string;
}

/**
 * Default bundled font (Departure Mono)
 * Use this for consistent rendering across projects
 */
export const DEFAULT_FONT: FontConfig = {
  family: 'Departure Mono',
  path: join(__dirname, '../../fonts/DepartureMono-Regular.woff2'),
  weight: 400,
  style: 'normal',
};

export interface MermaidConfig {
  theme?: 'default' | 'dark' | 'forest' | 'neutral' | 'base';
  themeVariables?: Record<string, string>;
  securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox';
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  fontFamily?: string;
  [key: string]: any;
}

export interface PuppeteerConfig {
  executablePath?: string;
  headless?: boolean | 'shell';
  args?: string[];
}

export interface MermaidSSROptions {
  fonts?: FontConfig[];
  mermaid?: MermaidConfig;
  puppeteer?: PuppeteerConfig;
  embedFonts?: boolean;
}

interface BrowserContext {
  browser: any;
  page: any;
}

let browserContext: BrowserContext | null = null;

/**
 * Load puppeteer lazily to avoid requiring it for non-SSR usage
 */
async function loadPuppeteer() {
  if (!pptr) {
    try {
      const mod = await import('puppeteer');
      pptr = mod.default || mod;
    } catch (e) {
      throw new Error(
        'puppeteer is required for server-side mermaid rendering. Install it with: npm install puppeteer'
      );
    }
  }
  return pptr;
}

/**
 * Load font file as base64
 */
function loadFontBase64(fontPath: string): string {
  const resolved = resolve(fontPath);
  if (!existsSync(resolved)) {
    console.warn(`Font file not found: ${resolved}`);
    return '';
  }
  return readFileSync(resolved).toString('base64');
}

/**
 * Fetch external font and convert to base64
 */
async function fetchFontBase64(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`Failed to fetch font: ${url}`);
      return '';
    }
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch (e) {
    console.warn(`Error fetching font: ${url}`, e);
    return '';
  }
}

/**
 * Check if URL is a Google Fonts CSS URL
 */
function isGoogleFontsCSS(url: string): boolean {
  return url.includes('fonts.googleapis.com/css');
}

/**
 * Generate font-face CSS from font configs
 */
async function generateFontFaceCSS(fonts: FontConfig[]): Promise<string> {
  const results = await Promise.all(
    fonts.map(async (font) => {
      // Handle external URL (Google Fonts CSS or direct font file)
      if (font.url) {
        if (isGoogleFontsCSS(font.url)) {
          // For Google Fonts CSS, just return @import
          // (won't work for embedded SVG, but works for page rendering)
          return `@import url('${font.url}');`;
        }
        // Direct font file URL - fetch and embed
        const base64 = await fetchFontBase64(font.url);
        if (!base64) return '';

        const format = font.url.includes('.woff2')
          ? 'woff2'
          : font.url.includes('.woff')
            ? 'woff'
            : 'truetype';

        return `
          @font-face {
            font-family: '${font.family}';
            src: url(data:font/${format};base64,${base64}) format('${format}');
            font-weight: ${font.weight || 400};
            font-style: ${font.style || 'normal'};
          }
        `;
      }

      // Handle local path
      if (font.path) {
        const base64 = loadFontBase64(font.path);
        if (!base64) return '';

        const format = font.path.endsWith('.woff2')
          ? 'woff2'
          : font.path.endsWith('.woff')
            ? 'woff'
            : font.path.endsWith('.ttf')
              ? 'truetype'
              : 'opentype';

        return `
          @font-face {
            font-family: '${font.family}';
            src: url(data:font/${format};base64,${base64}) format('${format}');
            font-weight: ${font.weight || 400};
            font-style: ${font.style || 'normal'};
          }
        `;
      }

      return '';
    })
  );

  return results.filter(Boolean).join('\n');
}

/**
 * Create a browser page configured for mermaid rendering
 */
async function createPage(options: MermaidSSROptions = {}): Promise<BrowserContext> {
  const pptr = await loadPuppeteer();

  const browser = await pptr.default.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...options.puppeteer,
  });

  const page = await browser.newPage();

  // Generate font CSS (now async)
  const fontCSS = options.fonts?.length ? await generateFontFaceCSS(options.fonts) : '';
  const fontFamilies = options.fonts?.map((f) => `'${f.family}'`).join(', ') || '';

  // Build HTML with fonts
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${fontCSS}
    ${fontFamilies ? `* { font-family: ${fontFamilies}, sans-serif !important; }` : ''}
  </style>
</head>
<body>
  <div id="container"></div>
</body>
</html>`;

  await page.setContent(html, { waitUntil: 'domcontentloaded' });

  // Load mermaid from node_modules
  let mermaidPath: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mermaidPkgPath = require.resolve('mermaid/package.json');
    mermaidPath = resolve(dirname(mermaidPkgPath), 'dist', 'mermaid.min.js');
  } catch {
    throw new Error('mermaid is required. Install it with: npm install mermaid');
  }

  await page.addScriptTag({ path: mermaidPath });

  // Initialize mermaid with config
  const mermaidConfig: MermaidConfig = {
    startOnLoad: false,
    securityLevel: 'loose',
    ...options.mermaid,
  };

  // Add font family to mermaid config if fonts provided
  if (fontFamilies && !mermaidConfig.fontFamily) {
    mermaidConfig.fontFamily = fontFamilies;
  }

  await page.evaluate((config: MermaidConfig) => {
    // @ts-ignore
    mermaid.initialize(config);
  }, mermaidConfig);

  return { browser, page };
}

/**
 * Get or create browser context (reuses browser for batch operations)
 */
async function getBrowserContext(options: MermaidSSROptions = {}): Promise<BrowserContext> {
  if (!browserContext) {
    browserContext = await createPage(options);
  }
  return browserContext;
}

/**
 * Close browser context
 */
export async function closeBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.browser.close();
    browserContext = null;
  }
}

/**
 * Normalize architecture-beta syntax to standard mermaid
 */
function normalizeArchitecture(mmd: string): string {
  let out = mmd.replace(/^\s*architecture-beta\b/m, 'architecture');
  if (/^\s*architecture\b/m.test(out)) {
    out = out.replace(/^(\s*)service\b/gm, '$1component');
    out = out.replace(/\b([LRBT]):([A-Za-z][\w-]*)\b/g, '$2.$1');
    out = out.replace(/\b([A-Za-z][\w-]*):([LRBT])\b/g, '$1.$2');
  }
  return out;
}

/**
 * Preprocess mermaid code for compatibility
 */
function preprocess(code: string): string {
  const first = (code.trim().split(/\s+/)[0] || '').toLowerCase();
  if (first === 'architecture' || first === 'architecture-beta') {
    return normalizeArchitecture(code);
  }
  return code;
}

/**
 * Render a single mermaid diagram to SVG
 */
async function renderSingle(page: any, code: string): Promise<string> {
  const preprocessed = preprocess(code);

  const svg = await page.evaluate(async (definition: string) => {
    // This code runs in browser context
    const container = (globalThis as any).document.getElementById('container');
    if (!container) return 'Error: container not found';

    try {
      const id = 'mermaid-' + Math.random().toString(36).slice(2);
      const { svg } = await (globalThis as any).mermaid.render(id, definition, container);
      return svg;
    } catch (e: any) {
      return `Error: ${e?.message || e}`;
    }
  }, preprocessed);

  return svg;
}

/**
 * Embed fonts into SVG
 */
async function embedFontsInSVG(svg: string, fonts: FontConfig[]): Promise<string> {
  if (!fonts?.length) return svg;

  const fontFaceRules = (
    await Promise.all(
      fonts.map(async (font) => {
        let base64 = '';
        let format = 'truetype';

        if (font.url) {
          if (isGoogleFontsCSS(font.url)) {
            // Can't embed Google Fonts CSS @import in SVG
            return '';
          }
          base64 = await fetchFontBase64(font.url);
          format = font.url.includes('.woff2')
            ? 'woff2'
            : font.url.includes('.woff')
              ? 'woff'
              : 'truetype';
        } else if (font.path) {
          base64 = loadFontBase64(font.path);
          format = font.path.endsWith('.woff2')
            ? 'woff2'
            : font.path.endsWith('.woff')
              ? 'woff'
              : 'truetype';
        }

        if (!base64) return '';

        return `@font-face{font-family:'${font.family}';src:url(data:font/${format};base64,${base64}) format('${format}');font-weight:${font.weight || 400};font-style:${font.style || 'normal'};}`;
      })
    )
  )
    .filter(Boolean)
    .join('');

  if (!fontFaceRules) return svg;

  // Insert font-face at the beginning of the first <style> block
  if (svg.includes('<style>')) {
    return svg.replace(/<style>/, `<style>${fontFaceRules}`);
  }

  // Or add a new style block after <svg>
  return svg.replace(/<svg([^>]*)>/, `<svg$1><style>${fontFaceRules}</style>`);
}

/**
 * Render mermaid code to SVG string
 *
 * @param code - Mermaid diagram code
 * @param options - Rendering options (fonts, mermaid config, etc.)
 * @returns SVG string
 *
 * @example
 * ```typescript
 * import { renderMermaidToSVG } from 'mdmaid/ssr';
 *
 * const svg = await renderMermaidToSVG('graph TD; A-->B;', {
 *   fonts: [{ family: 'Departure Mono', path: './fonts/DepartureMono.woff2' }],
 *   mermaid: { theme: 'dark' },
 *   embedFonts: true,
 * });
 * ```
 */
export async function renderMermaidToSVG(
  code: string,
  options: MermaidSSROptions = {}
): Promise<string> {
  const ctx = await getBrowserContext(options);
  let svg = await renderSingle(ctx.page, code);

  if (svg.startsWith('<svg') && options.embedFonts && options.fonts?.length) {
    svg = await embedFontsInSVG(svg, options.fonts);
  }

  return svg;
}

/**
 * Render multiple mermaid diagrams to SVG strings
 * More efficient than calling renderMermaidToSVG multiple times
 *
 * @param codes - Array of mermaid diagram codes
 * @param options - Rendering options
 * @returns Array of SVG strings
 */
export async function renderMermaidBatch(
  codes: string[],
  options: MermaidSSROptions = {}
): Promise<string[]> {
  const ctx = await getBrowserContext(options);
  const results: string[] = [];

  for (const code of codes) {
    let svg = await renderSingle(ctx.page, code);

    if (svg.startsWith('<svg') && options.embedFonts && options.fonts?.length) {
      svg = await embedFontsInSVG(svg, options.fonts);
    }

    results.push(svg);
  }

  return results;
}

/**
 * Render mermaid and auto-close browser when done
 * Use this for one-off renders, use renderMermaidToSVG + closeBrowser for batches
 */
export async function renderMermaidOnce(
  code: string,
  options: MermaidSSROptions = {}
): Promise<string> {
  try {
    return await renderMermaidToSVG(code, options);
  } finally {
    await closeBrowser();
  }
}

export type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral' | 'base';

export interface ThemeRenderResult {
  theme: MermaidTheme;
  svg: string;
}

/**
 * Render mermaid diagram with multiple themes (e.g., for light/dark mode)
 *
 * This renders the same diagram multiple times with different themes,
 * useful when you want to serve different versions for light/dark mode
 * instead of using CSS invert.
 *
 * @param code - Mermaid diagram code
 * @param themes - Array of themes to render (default: ['default', 'dark'])
 * @param options - Rendering options
 * @returns Array of { theme, svg } objects
 *
 * @example
 * ```typescript
 * import { renderMermaidWithThemes, closeBrowser } from 'mdmaid/ssr';
 *
 * const results = await renderMermaidWithThemes(
 *   'graph TD; A-->B;',
 *   ['default', 'dark'],
 *   { fonts: [{ family: 'Departure Mono', path: './fonts/DepartureMono.woff2' }] }
 * );
 *
 * // results[0] = { theme: 'default', svg: '<svg>...</svg>' }
 * // results[1] = { theme: 'dark', svg: '<svg>...</svg>' }
 *
 * await closeBrowser();
 * ```
 */
export async function renderMermaidWithThemes(
  code: string,
  themes: MermaidTheme[] = ['default', 'dark'],
  options: Omit<MermaidSSROptions, 'mermaid'> & { mermaid?: Omit<MermaidConfig, 'theme'> } = {}
): Promise<ThemeRenderResult[]> {
  const results: ThemeRenderResult[] = [];

  for (const theme of themes) {
    // Close existing browser to apply new theme config
    await closeBrowser();

    const svg = await renderMermaidToSVG(code, {
      ...options,
      mermaid: {
        ...options.mermaid,
        theme,
      },
    });

    results.push({ theme, svg });
  }

  return results;
}

/**
 * Render multiple diagrams with multiple themes
 *
 * @param codes - Array of mermaid diagram codes
 * @param themes - Array of themes to render
 * @param options - Rendering options
 * @returns Map of theme -> array of SVGs
 *
 * @example
 * ```typescript
 * const results = await renderMermaidBatchWithThemes(
 *   ['graph TD; A-->B;', 'sequenceDiagram; A->>B: Hi'],
 *   ['default', 'dark']
 * );
 *
 * // results.get('default') = ['<svg>...</svg>', '<svg>...</svg>']
 * // results.get('dark') = ['<svg>...</svg>', '<svg>...</svg>']
 * ```
 */
export async function renderMermaidBatchWithThemes(
  codes: string[],
  themes: MermaidTheme[] = ['default', 'dark'],
  options: Omit<MermaidSSROptions, 'mermaid'> & { mermaid?: Omit<MermaidConfig, 'theme'> } = {}
): Promise<Map<MermaidTheme, string[]>> {
  const results = new Map<MermaidTheme, string[]>();

  for (const theme of themes) {
    // Close existing browser to apply new theme config
    await closeBrowser();

    const svgs = await renderMermaidBatch(codes, {
      ...options,
      mermaid: {
        ...options.mermaid,
        theme,
      },
    });

    results.set(theme, svgs);
  }

  return results;
}
