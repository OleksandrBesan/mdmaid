# mdmaid

**Markdown + Mermaid rendering library**

A preconfigured markdown renderer with Mermaid diagram support. Built for personal use across [mdmaid.nvim](https://github.com/olesbesan/mdmaid.nvim) and [oles.md](https://github.com/olesbesan/oles.md) blog.

## What it does today

- Markdown → HTML via remark (GFM, slug, autolink-headings)
- Mermaid code blocks → `<div class="mermaid">` (client-side rendering)
- **SSR module** - Server-side mermaid → SVG rendering with font embedding
- **Bundled font** - Departure Mono included for consistent diagram rendering
- CLI for quick rendering and dev server with live reload
- Dev server extras: ToC sidebar, image zoom, print styles

## Installation

```bash
npm install mdmaid

# For SSR (optional)
npm install puppeteer
```

## Usage

### Markdown Rendering

```typescript
import { renderMarkdown } from 'mdmaid';

const html = await renderMarkdown(`
# Hello

\`\`\`mermaid
graph TD
    A[Start] --> B[End]
\`\`\`
`);
// Returns HTML with <div class="mermaid">...</div>
// Mermaid renders client-side
```

### Server-Side Mermaid Rendering

Render mermaid diagrams to SVG on the server (requires puppeteer):

```typescript
import { renderMermaidToSVG, closeBrowser, DEFAULT_FONT } from 'mdmaid/ssr';

// Use the bundled Departure Mono font
const svg = await renderMermaidToSVG('graph TD; A-->B;', {
  fonts: [DEFAULT_FONT],
  embedFonts: true,
});

await closeBrowser();
```

Or with custom fonts:

```typescript
const svg = await renderMermaidToSVG('graph TD; A-->B;', {
  fonts: [
    // Local font file
    { family: 'My Font', path: './fonts/MyFont.woff2' },
    // Or external URL
    { family: 'Fira Code', url: 'https://example.com/FiraCode.woff2' },
  ],
  mermaid: { theme: 'default' },
  embedFonts: true,
});
```

### Batch Rendering

More efficient for multiple diagrams:

```typescript
import { renderMermaidBatch, closeBrowser } from 'mdmaid/ssr';

const svgs = await renderMermaidBatch(
  ['graph TD; A-->B;', 'sequenceDiagram; A->>B: Hi'],
  { embedFonts: true }
);

await closeBrowser();
```


### Dark Mode Options

**Option 1: CSS Invert (simple, used in oles.md)**

Render once in light theme, use CSS to invert in dark mode:

```css
.dark .mermaid img { filter: invert(1); }
/* or with Tailwind: className="dark:invert" */
```

**Option 2: Dual Theme Rendering**

Render separate versions for light and dark:

```typescript
import { renderMermaidWithThemes, closeBrowser } from 'mdmaid/ssr';

const results = await renderMermaidWithThemes(
  'graph TD; A-->B;',
  ['default', 'dark'],  // themes to render
  { embedFonts: true }
);

// results[0] = { theme: 'default', svg: '<svg>...</svg>' }
// results[1] = { theme: 'dark', svg: '<svg>...</svg>' }

await closeBrowser();
```

### CLI

```bash
# Render markdown to stdout
mdmaid README.md

# Render to file
mdmaid README.md -o output.html

# Dev server with live reload
mdmaid serve docs/index.md --watch --port 3333

# Batch render mermaid diagrams to SVG (requires puppeteer)
mdmaid render-diagrams _posts/ --out public/diagrams/ --manifest
```

## API Reference

### Core

#### `renderMarkdown(markdown, options?)`

```typescript
const html = await renderMarkdown(content, {
  sanitize: false,  // HTML sanitization (default: false)
});
```

#### `extractMermaidBlocks(markdown)`

```typescript
const blocks = extractMermaidBlocks(content);
// ['graph TD\n  A --> B', 'sequenceDiagram\n  ...']
```

### SSR (`mdmaid/ssr`)

#### `renderMermaidToSVG(code, options?)`

Render single diagram to SVG.

#### `renderMermaidBatch(codes, options?)`

Render multiple diagrams efficiently (reuses browser).

#### `renderMermaidWithThemes(code, themes?, options?)`

Render diagram with multiple themes for light/dark mode.

#### `renderMermaidBatchWithThemes(codes, themes?, options?)`

Batch render with multiple themes.

#### `closeBrowser()`

Clean up puppeteer browser when done.

#### `DEFAULT_FONT`

Bundled Departure Mono font config. Use for consistent rendering:

```typescript
import { DEFAULT_FONT } from 'mdmaid/ssr';
// { family: 'Departure Mono', path: '...', weight: 400, style: 'normal' }
```

#### Options

```typescript
interface MermaidSSROptions {
  fonts?: FontConfig[];       // Fonts to use
  mermaid?: MermaidConfig;    // Mermaid configuration
  puppeteer?: PuppeteerConfig; // Puppeteer launch options
  embedFonts?: boolean;       // Embed fonts in SVG (default: false)
}

interface FontConfig {
  family: string;             // Font family name
  path?: string;              // Local file path (.woff2, .woff, .ttf)
  url?: string;               // External URL (CDN, direct font file)
  weight?: number;            // Font weight (default: 400)
  style?: string;             // Font style (default: 'normal')
}
```

## Dev Server Features

- Live reload on file changes
- Auto-generated Table of Contents sidebar
- Image magnifier (hold `Z` or click to zoom)
- Print-friendly styles

---

## Ideas Still Being Explored

### Layout & Responsiveness

**The pain:**
- Diagrams clip on mobile / narrow containers
- No text wrapping in nodes (manual `<br>` hell)
- Large diagrams become unreadable thumbnails

**Potential approach:**
- Smart container-aware rendering
- Pan/zoom for large diagrams
- Viewport-based sizing hints

### Validation & Error Handling

**The pain:**
- Works in VS Code, breaks on GitHub (version mismatch)
- Single typo → ugly error block on published site
- No graceful fallback

**Potential approach:**
- Pre-flight syntax validation
- Graceful error states
- Version compatibility checking

### Accessibility

**The pain:** SVG diagrams are invisible to screen readers. `accTitle` and `accDescr` exist but nobody knows about them.

**Potential approach:**
- Auto-generate descriptions from diagram structure
- Enforce/encourage accessibility metadata
- Semantic alternatives for simple diagrams

### Puppeteer-free SSR

Current SSR requires puppeteer. Exploring:
- jsdom-based rendering
- WASM-based mermaid

---

## The Honest Truth

This library exists because I needed shared rendering logic between my Neovim plugin and my blog.

The SSR module is extracted from [oles.md](https://github.com/olesbesan/oles.md) and works. The "ideas" above are things that would be nice to have but aren't priorities.

## Development

```bash
npm install
npm run build
npm run dev  # watch mode

# Test locally
node bin/mdmaid.js test.md -o test-output.html
node bin/mdmaid.js serve test.md --watch
```

## License

MIT
