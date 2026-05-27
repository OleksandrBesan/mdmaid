import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname, basename, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { watch, FSWatcher } from 'chokidar';
import { renderMarkdown } from '../core/renderer.js';
import {
  DocumentConflictError,
  appendMermaidBlock,
  findMermaidBlocks,
  readDocument,
  replaceMermaidBlock,
  writeDocumentIfUnchanged,
} from '../core/document.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerOptions {
  port?: number;
  watch?: boolean;
  host?: string;
}

interface FileInfo {
  path: string;
  name: string;
  relativePath: string;
}

interface TocItem {
  id: string;
  text: string;
  level: number;
}

interface ServerState {
  files: Map<string, FileInfo>;
  currentFile: string | null;
  baseDir: string;
}

interface WsMessage {
  action: 'switch' | 'add' | 'remove' | 'list';
  file?: string;
}

/**
 * Extract table of contents from HTML
 */
function extractTOC(html: string): TocItem[] {
  const headingRegex = /<h([1-6])\s+id="([^"]+)"[^>]*>(?:<a[^>]*>.*?<\/a>)?([^<]+)<\/h[1-6]>/g;
  const toc: TocItem[] = [];
  let match;

  while ((match = headingRegex.exec(html))) {
    const level = parseInt(match[1]);
    const id = match[2];
    const text = match[3].trim();
    toc.push({ id, text, level });
  }

  return toc;
}

/**
 * Generate HTML template with file picker, TOC and Magnifier
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateHTMLTemplate(
  content: string,
  currentFile: FileInfo,
  allFiles: FileInfo[],
  baseDir: string
): string {
  const toc = extractTOC(content);

  const filesHTML = allFiles.length > 0 ? `
    <div class="files-section">
      <div class="section-header">Files</div>
      <ul class="files-list">
        ${allFiles.map(f => `
          <li class="file-item ${f.path === currentFile.path ? 'active' : ''}" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.relativePath)}">
            <span class="file-select" data-file="${escapeHtml(f.path)}">
              <span class="file-icon">📄</span>
              <span class="file-name">${escapeHtml(f.name)}</span>
            </span>
            <button class="file-remove" data-file="${escapeHtml(f.path)}" title="Remove from preview" aria-label="Remove ${escapeHtml(f.name)}">×</button>
          </li>
        `).join('')}
      </ul>
    </div>
  ` : '';

  const tocHTML = toc.length > 0 ? `
    <div class="toc-section">
      <div class="section-header">Contents <span style="font-weight:normal;opacity:0.6">// press code to jump</span></div>
      <ul class="toc-list">
        ${toc.map((item, idx) => {
          const group = Math.floor(idx / 9);
          const num = (idx % 9) + 1;
          const code = String.fromCharCode(97 + group) + num;
          return `
          <li class="toc-item toc-level-${item.level}" data-toc-idx="${idx}">
            <a href="#${item.id}">${item.text}<span class="toc-code">[${code}]</span></a>
          </li>
        `}).join('')}
      </ul>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${currentFile.name} - mdmaid</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">

  <!-- Preload font for mermaid -->
  <link rel="preload" href="/fonts/DepartureMono-Regular.woff2" as="font" type="font/woff2" crossorigin>

  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

    // Wait for font to load
    await document.fonts.load('11px "Departure Mono"').catch(() => {});

    // Load external diagram plugins
    async function loadPlugins() {
      const plugins = [];
      const pluginUrls = [
        'https://unpkg.com/@mermaid-js/mermaid-architecture-diagram/dist/mermaid-architecture-diagram.esm.mjs',
        'https://unpkg.com/@mermaid-js/mermaid-kanban/dist/mermaid-kanban.esm.mjs'
      ];

      for (const url of pluginUrls) {
        try {
          const mod = await import(url);
          if (mod.default) plugins.push(mod.default);
          else if (mod.plugin) plugins.push(mod.plugin);
          else plugins.push(mod);
        } catch (e) {
          console.warn('Failed to load mermaid plugin:', url, e);
        }
      }

      if (plugins.length > 0) {
        try {
          await mermaid.registerExternalDiagrams(plugins);
        } catch (e) {
          console.warn('Failed to register plugins:', e);
        }
      }
    }

    await loadPlugins();

    // Full mermaid config matching blog
    mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      securityLevel: 'loose',
      fontFamily: 'Departure Mono, monospace',
      themeVariables: {
        background: 'transparent',
        fontFamily: 'Departure Mono, monospace',
        fontSize: '11px',

        primaryColor: '#ffffff',
        primaryTextColor: '#000000',
        primaryBorderColor: '#000000',
        secondaryColor: '#f5f5f5',
        secondaryTextColor: '#000000',
        secondaryBorderColor: '#000000',
        tertiaryColor: '#e5e5e5',
        tertiaryTextColor: '#000000',
        tertiaryBorderColor: '#000000',

        lineColor: '#000000',
        textColor: '#000000',

        mainBkg: '#ffffff',
        nodeBorder: '#000000',
        clusterBkg: '#f5f5f5',
        clusterBorder: '#000000',
        titleColor: '#000000',
        edgeLabelBackground: '#ffffff',
        nodeTextColor: '#000000',

        actorBkg: '#ffffff',
        actorBorder: '#000000',
        actorTextColor: '#000000',
        actorLineColor: '#000000',

        signalColor: '#000000',
        signalTextColor: '#000000',

        labelBoxBkgColor: '#ffffff',
        labelBoxBorderColor: '#000000',
        labelTextColor: '#000000',

        loopTextColor: '#000000',

        noteBkgColor: '#ffffff',
        noteTextColor: '#000000',
        noteBorderColor: '#000000',

        activationBkgColor: '#f5f5f5',
        activationBorderColor: '#000000',

        sequenceNumberColor: '#000000',

        sectionBkgColor: '#ffffff',
        altSectionBkgColor: '#f5f5f5',
        sectionBkgColor2: '#ffffff',

        taskBkgColor: '#ffffff',
        taskTextColor: '#000000',
        taskTextLightColor: '#000000',
        taskTextOutsideColor: '#000000',
        taskTextClickableColor: '#000000',
        taskBorderColor: '#000000',

        activeTaskBkgColor: '#e5e5e5',
        activeTaskBorderColor: '#000000',

        gridColor: '#cccccc',
        doneTaskBkgColor: '#f5f5f5',
        doneTaskBorderColor: '#000000',

        critBkgColor: '#ffffff',
        critBorderColor: '#000000',

        todayLineColor: '#000000',

        personBkg: '#ffffff',
        personBorder: '#000000',
      }
    });
  </script>

  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>hljs.highlightAll();</script>

  <style>
    @font-face {
      font-family: 'Departure Mono';
      src: url('/fonts/DepartureMono-Regular.woff2') format('woff2');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --font-mono: 'Departure Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace;
      --font-emoji: 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
      --bg-primary: #ffffff;
      --bg-secondary: #f6f8fa;
      --text-primary: #000000;
      --text-secondary: #586069;
      --border-color: #e1e4e8;
      --accent-color: #000000;
    }

    .dark {
      --bg-primary: #0a0a0a;
      --bg-secondary: #111111;
      --text-primary: #ffffff;
      --text-secondary: #a0a0a0;
      --border-color: #333333;
      --accent-color: #ffffff;
    }

    body {
      font-family: var(--font-mono), var(--font-emoji);
      font-size: 13px;
      line-height: 1.6;
      color: var(--text-primary);
      background: var(--bg-secondary);
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 20px;
      padding: 20px;
      min-height: 100vh;
    }

    .sidebar {
      position: sticky;
      top: 20px;
      height: fit-content;
      max-height: calc(100vh - 40px);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .files-section, .toc-section {
      background: var(--bg-primary);
      border-radius: 0;
      padding: 16px;
      border: 1px solid var(--text-primary);
    }

    .section-header {
      font-weight: 400;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--text-primary);
    }

    .files-list, .toc-list {
      list-style: none;
    }

    .file-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 11px;
      transition: all 0.15s;
      border: 1px solid transparent;
    }

    .file-select {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }

    .file-item:hover {
      border-color: var(--text-primary);
    }

    .file-item.active {
      background: var(--text-primary);
      color: var(--bg-primary);
    }

    .file-item.active .file-icon {
      opacity: 1;
    }

    .file-icon {
      opacity: 0.6;
      font-size: 11px;
      flex: 0 0 auto;
    }

    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-remove {
      flex: 0 0 auto;
      border: 1px solid transparent;
      background: transparent;
      color: inherit;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1;
      padding: 2px 5px;
      cursor: pointer;
      opacity: 0.55;
    }

    .file-remove:hover {
      opacity: 1;
      border-color: currentColor;
    }

    .toc-item {
      margin: 2px 0;
    }

    .toc-item a {
      display: block;
      padding: 4px 8px;
      text-decoration: none;
      color: var(--text-primary);
      font-size: 11px;
      transition: all 0.15s;
      border-bottom: 1px dashed transparent;
    }

    .toc-item a:hover {
      border-bottom-color: var(--text-primary);
    }

    .toc-level-1 { font-weight: 600; }
    .toc-level-2 { padding-left: 12px; }
    .toc-level-3 { padding-left: 24px; opacity: 0.8; }
    .toc-level-4 { padding-left: 36px; opacity: 0.7; }
    .toc-level-5, .toc-level-6 { padding-left: 48px; opacity: 0.6; }

    .content {
      background: var(--bg-primary);
      border: 1px solid var(--text-primary);
      padding: 40px;
      max-width: 900px;
      position: relative;
    }

    .content h1, .content h2, .content h3,
    .content h4, .content h5, .content h6 {
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      font-weight: 600;
      line-height: 1.25;
    }

    .content h1 { font-size: 1.5em; border-bottom: 1px solid var(--text-primary); padding-bottom: 8px; }
    .content h2 { font-size: 1.25em; border-bottom: 1px dashed var(--text-primary); padding-bottom: 8px; }
    .content h3 { font-size: 1.1em; margin-top: 1.25em; }

    .content p { margin: 1em 0; }
    .content ul, .content ol { margin: 1em 0; padding-left: 2em; }
    .content li { margin: 4px 0; }

    .content a {
      color: var(--text-primary);
      text-decoration: none;
      border-bottom: 1px dashed var(--text-primary);
      transition: border-bottom 0.15s;
    }
    .content a:hover {
      border-bottom: 2px solid var(--text-primary);
    }

    .content pre {
      background: transparent;
      padding: 16px;
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid var(--text-primary);
    }

    .content code {
      background: var(--bg-secondary);
      padding: 2px 6px;
      font-family: var(--font-mono), var(--font-emoji);
      font-size: 0.9em;
    }

    .content pre code {
      background: none;
      padding: 0;
      font-size: 11px;
    }

    /* Keep large screenshots/diagrams inside the readable page width. */
    .content img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 16px auto;
    }

    .content table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 0.95em;
    }

    .content th,
    .content td {
      border: 1px solid var(--border-color);
      padding: 6px 10px;
      text-align: left;
      vertical-align: top;
    }

    .content th {
      background: var(--bg-secondary);
      font-weight: 600;
    }

    .content tr:nth-child(even) td {
      background: color-mix(in srgb, var(--bg-secondary) 45%, transparent);
    }

    .content .mermaid {
      margin: 24px 0;
      text-align: center;
      background: transparent !important;
      border: 1px solid var(--border-color);
      padding: 16px;
      overflow-x: auto;
      page-break-inside: avoid;
      break-inside: avoid;
    }

    .content .mermaid svg {
      background: transparent !important;
      max-width: 100%;
      height: auto;
    }

    /* Magnifier-enabled images */
    .content img:not([data-no-zoom]) {
      cursor: zoom-in;
      transition: transform 0.2s;
    }

    /* Mermaid text and labels use the monospace font */
    .content .mermaid text,
    .content .mermaid .label,
    .content .mermaid .nodeLabel,
    .content .mermaid .edgeLabel,
    .content .mermaid .cluster-label,
    .content .mermaid .title,
    .content .mermaid tspan {
      font-family: var(--font-mono) !important;
      font-size: 11px !important;
    }

    /* Mermaid node styling */
    .content .mermaid .node rect,
    .content .mermaid .node circle,
    .content .mermaid .node ellipse,
    .content .mermaid .node polygon,
    .content .mermaid .node path {
      stroke: var(--text-primary) !important;
      stroke-width: 1px !important;
    }

    /* Mermaid edge styling */
    .content .mermaid .edgePath path {
      stroke: var(--text-primary) !important;
      stroke-width: 1px !important;
    }

    .content .mermaid marker path {
      fill: var(--text-primary) !important;
    }

    /* Cluster/subgraph styling */
    .content .mermaid .cluster rect {
      stroke: var(--text-primary) !important;
      stroke-width: 1px !important;
      stroke-dasharray: 4,4 !important;
    }

    /* Dark mode mermaid - use invert filter like blog */
    .dark .content .mermaid svg {
      filter: invert(1) hue-rotate(180deg);
    }

    /* Dark mode code highlighting */
    .dark .hljs {
      background: transparent !important;
      color: #e5e7eb !important;
    }

    .dark .hljs-keyword { color: #ff79c6 !important; }
    .dark .hljs-string { color: #f1fa8c !important; }
    .dark .hljs-number { color: #bd93f9 !important; }
    .dark .hljs-comment { color: #6272a4 !important; }
    .dark .hljs-function { color: #50fa7b !important; }
    .dark .hljs-title { color: #8be9fd !important; }
    .dark .hljs-params { color: #ffb86c !important; }
    .dark .hljs-built_in { color: #8be9fd !important; }
    .dark .hljs-literal { color: #bd93f9 !important; }
    .dark .hljs-attr { color: #50fa7b !important; }

    /* Theme toggle button */
    .theme-toggle {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 1001;
      background: var(--bg-primary);
      border: 1px solid var(--text-primary);
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 6px 12px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .theme-toggle:hover {
      background: var(--text-primary);
      color: var(--bg-primary);
    }

    .file-path {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      background: transparent;
      padding: 8px 0;
      margin-bottom: 20px;
      border-bottom: 1px dashed var(--text-primary);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .print-button {
      background: transparent;
      border: 1px solid var(--text-primary);
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: lowercase;
      cursor: pointer;
      padding: 4px 8px;
      transition: all 0.15s;
    }

    .print-button:hover {
      background: var(--text-primary);
      color: var(--bg-primary);
    }

    .status-bar {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      gap: 8px;
      z-index: 1000;
    }

    .status-indicator {
      padding: 6px 12px;
      font-size: 11px;
      font-family: var(--font-mono);
      border: 1px solid var(--text-primary);
      background: var(--bg-primary);
    }

    .live-indicator {
      color: var(--text-primary);
    }

    .live-indicator.disconnected {
      background: var(--text-primary);
      color: var(--bg-primary);
    }

    .file-count {
      color: var(--text-secondary);
    }

    @media print {
      body { grid-template-columns: 1fr; padding: 0; background: white; }
      .sidebar, .status-bar { display: none !important; }
      .content { box-shadow: none; max-width: 100%; padding: 20px; }
      .content .mermaid,
      .content pre,
      .content img,
      .content svg,
      .content table {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
    }

    @media (max-width: 768px) {
      body { grid-template-columns: 1fr; }
      .sidebar { position: static; flex-direction: row; flex-wrap: wrap; }
      .files-section, .toc-section { flex: 1; min-width: 200px; }
    }

    /* Sidebar toggle */
    .sidebar.hidden { display: none; }
    body.sidebar-hidden { grid-template-columns: 1fr; }

    /* Help overlay */
    .help-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(4px);
    }

    .help-overlay.open { display: flex; justify-content: center; padding-top: 80px; }

    .help-content {
      background: var(--bg-primary);
      border: 1px solid var(--text-primary);
      padding: 24px;
      max-width: 600px;
      width: 100%;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
    }

    .help-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--text-primary);
    }

    .help-section {
      margin-bottom: 20px;
    }

    .help-section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }

    .help-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      font-size: 11px;
      border-bottom: 1px dotted var(--border-color);
    }

    .help-key {
      font-family: var(--font-mono);
      background: var(--bg-secondary);
      padding: 2px 6px;
      border: 1px solid var(--border-color);
    }

    .help-desc {
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.2em;
      font-size: 10px;
    }

    /* TOC hotkey codes */
    .toc-code {
      color: var(--text-secondary);
      font-size: 10px;
      margin-left: 4px;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    ${filesHTML}
    ${tocHTML}
  </div>

  <div class="content">
    <div class="file-path">
      <span>📄 ${currentFile.relativePath}</span>
      <button class="print-button" onclick="window.print()">[print]</button>
    </div>
    ${content}
  </div>

  <button class="theme-toggle" id="theme-toggle">[dark]</button>

  <div class="status-bar">
    <div class="status-indicator file-count" id="file-count">${allFiles.length} file${allFiles.length !== 1 ? 's' : ''}</div>
    <div class="status-indicator live-indicator" id="live-indicator">● Live</div>
  </div>

  <!-- Help Overlay -->
  <div class="help-overlay" id="help-overlay">
    <div class="help-content" onclick="event.stopPropagation()">
      <div class="help-title">keyboard shortcuts</div>

      <div class="help-section">
        <div class="help-section-title">navigation</div>
        <div class="help-row"><span class="help-key">j / k</span><span class="help-desc">scroll down / up</span></div>
        <div class="help-row"><span class="help-key">d / u</span><span class="help-desc">page down / up</span></div>
        <div class="help-row"><span class="help-key">gg / G</span><span class="help-desc">top / bottom</span></div>
        <div class="help-row"><span class="help-key">b</span><span class="help-desc">go back</span></div>
      </div>

      <div class="help-section">
        <div class="help-section-title">interface</div>
        <div class="help-row"><span class="help-key">t</span><span class="help-desc">toggle sidebar</span></div>
        <div class="help-row"><span class="help-key">D</span><span class="help-desc">toggle dark mode</span></div>
        <div class="help-row"><span class="help-key">?</span><span class="help-desc">toggle help</span></div>
        <div class="help-row"><span class="help-key">Esc</span><span class="help-desc">close overlays</span></div>
      </div>

      <div class="help-section">
        <div class="help-section-title">images</div>
        <div class="help-row"><span class="help-key">z (hold)</span><span class="help-desc">magnifier</span></div>
        <div class="help-row"><span class="help-key">click</span><span class="help-desc">toggle lock</span></div>
      </div>

      <div class="help-section">
        <div class="help-section-title">quick jump</div>
        <div class="help-row"><span class="help-key">a1-z9</span><span class="help-desc">jump to toc item</span></div>
      </div>
    </div>
  </div>

  <script>
    // ═══════════════════════════════════════════════════════════════
    // Theme Switching (dark/light mode)
    // ═══════════════════════════════════════════════════════════════
    (function() {
      const STORAGE_KEY = 'mdmaid-theme';
      const toggle = document.getElementById('theme-toggle');

      function getSystemTheme() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }

      function getStoredTheme() {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === 'dark' || stored === 'light' ? stored : null;
      }

      function applyTheme(theme) {
        if (theme === 'dark') {
          document.documentElement.classList.add('dark');
          toggle.textContent = '[light]';
        } else {
          document.documentElement.classList.remove('dark');
          toggle.textContent = '[dark]';
        }
      }

      function getCurrentTheme() {
        return getStoredTheme() || getSystemTheme();
      }

      // Apply theme on load
      applyTheme(getCurrentTheme());

      // Toggle handler
      toggle.addEventListener('click', () => {
        const current = getCurrentTheme();
        const next = current === 'dark' ? 'light' : 'dark';
        localStorage.setItem(STORAGE_KEY, next);
        applyTheme(next);
      });

      // Listen for system theme changes
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (!getStoredTheme()) {
          applyTheme(getSystemTheme());
        }
      });
    })();

    // WebSocket connection
    const ws = new WebSocket('ws://' + location.host);
    const indicator = document.getElementById('live-indicator');
    const fileCount = document.getElementById('file-count');

    ws.onopen = () => {
      indicator.textContent = '● Live';
      indicator.classList.remove('disconnected');
    };

    ws.onclose = () => {
      indicator.textContent = '● Disconnected';
      indicator.classList.add('disconnected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.action === 'reload') {
          location.reload();
        } else if (msg.action === 'update') {
          // Full page update with new content
          location.reload();
        } else if (msg.action === 'files') {
          // Update file count
          fileCount.textContent = msg.files.length + ' file' + (msg.files.length !== 1 ? 's' : '');
        } else if (msg.action === 'error') {
          console.warn('mdmaid skipped file:', msg.file, msg.error);
          const name = msg.file ? msg.file.split(/[\\/]/).pop() : 'file';
          fileCount.textContent = 'Skipped ' + name + ': ' + msg.error;
        }
      } catch {
        // Legacy: plain text reload message
        if (event.data === 'reload') {
          location.reload();
        }
      }
    };

    // File switching/removal via sidebar click
    document.querySelectorAll('.file-select').forEach(item => {
      item.addEventListener('click', () => {
        const file = item.dataset.file;
        if (file) {
          ws.send(JSON.stringify({ action: 'switch', file }));
        }
      });
    });

    document.querySelectorAll('.file-remove').forEach(button => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const file = button.dataset.file;
        if (file) {
          ws.send(JSON.stringify({ action: 'remove', file }));
        }
      });
    });

    // TOC smooth scroll
    document.querySelectorAll('.toc-item a').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const id = link.getAttribute('href').substring(1);
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // Mermaid re-init after dynamic content
    setTimeout(() => {
      if (window.mermaid) {
        window.mermaid.contentLoaded();
      }
    }, 500);

    // ═══════════════════════════════════════════════════════════════
    // Hotkeys (vim-like scrolling + image magnifier)
    // ═══════════════════════════════════════════════════════════════

    function isTypingTarget(el) {
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    }

    // Help overlay
    const helpOverlay = document.getElementById('help-overlay');
    const sidebar = document.querySelector('.sidebar');

    function toggleHelp() {
      helpOverlay.classList.toggle('open');
    }

    function closeHelp() {
      helpOverlay.classList.remove('open');
    }

    function toggleSidebar() {
      sidebar.classList.toggle('hidden');
      document.body.classList.toggle('sidebar-hidden');
    }

    helpOverlay.addEventListener('click', closeHelp);

    // Quick jump sequence state
    let seqLetter = null;
    let seqTimer = null;

    function clearSeq() {
      if (seqTimer) clearTimeout(seqTimer);
      seqLetter = null;
      seqTimer = null;
    }

    // Get TOC items for quick jump
    function getTocItems() {
      return Array.from(document.querySelectorAll('.toc-item a'));
    }

    // Vim-like scrolling + interface hotkeys
    document.addEventListener('keydown', (e) => {
      if (isTypingTarget(e.target)) return;

      // ? - toggle help
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        toggleHelp();
        e.preventDefault();
        return;
      }

      // Escape - close overlays
      if (e.key === 'Escape') {
        closeHelp();
        clearSeq();
        e.preventDefault();
        return;
      }

      // t - toggle sidebar
      if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        toggleSidebar();
        e.preventDefault();
        return;
      }

      // D - toggle dark mode
      if (e.key === 'D' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        document.getElementById('theme-toggle').click();
        e.preventDefault();
        return;
      }

      // j/k - scroll up/down
      if (!e.shiftKey && (e.key === 'j' || e.key === 'k')) {
        const delta = e.key === 'j' ? 120 : -120;
        window.scrollBy({ top: delta, behavior: 'smooth' });
        e.preventDefault();
        return;
      }

      // u/d - page up/down (80% viewport)
      if (e.key === 'u' || e.key === 'd') {
        const delta = e.key === 'd' ? window.innerHeight * 0.8 : -window.innerHeight * 0.8;
        window.scrollBy({ top: delta, behavior: 'smooth' });
        e.preventDefault();
        return;
      }

      // gg - scroll to top
      if (e.key === 'g' && !e.shiftKey) {
        let handled = false;
        const once = (ev) => {
          if (ev.key === 'g') {
            handled = true;
            window.scrollTo({ top: 0, behavior: 'smooth' });
            ev.preventDefault();
          }
          window.removeEventListener('keydown', once, true);
        };
        window.addEventListener('keydown', once, true);
        setTimeout(() => {
          if (!handled) window.removeEventListener('keydown', once, true);
        }, 250);
        return;
      }

      // G - scroll to bottom
      if (e.key === 'G' && e.shiftKey) {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        e.preventDefault();
        return;
      }

      // b - go back
      if (e.key === 'b' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        window.history.back();
        e.preventDefault();
        return;
      }

      // Quick jump: letter (a-z) then digit (1-9)
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const ch = e.key.toLowerCase();
        if (/^[a-z]$/.test(ch) && ch !== 'j' && ch !== 'k' && ch !== 'u' && ch !== 'd' && ch !== 'g' && ch !== 'b' && ch !== 't' && ch !== 'z') {
          clearSeq();
          seqLetter = ch;
          seqTimer = setTimeout(clearSeq, 800);
          e.preventDefault();
          return;
        }
        if (seqLetter && /^[1-9]$/.test(ch)) {
          const group = seqLetter.charCodeAt(0) - 97;
          const num = parseInt(ch, 10);
          const idx = group * 9 + (num - 1);
          const tocItems = getTocItems();
          if (tocItems[idx]) {
            const href = tocItems[idx].getAttribute('href');
            if (href && href.startsWith('#')) {
              const el = document.getElementById(href.substring(1));
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }
          clearSeq();
          e.preventDefault();
          return;
        }
      }
    });

    // ═══════════════════════════════════════════════════════════════
    // Image Magnifier (hold Z to zoom, click to toggle lock)
    // ═══════════════════════════════════════════════════════════════

    (function() {
      let zKeyPressed = false;
      let clickLocked = false;
      let currentTarget = null;
      let magnifierGlass = null;

      // Create magnifier element
      function createMagnifier() {
        if (magnifierGlass) return magnifierGlass;
        magnifierGlass = document.createElement('div');
        magnifierGlass.id = 'zoom-magnifier';
        magnifierGlass.style.cssText = \`
          position: fixed;
          width: 400px;
          height: 400px;
          border: 2px solid var(--text-primary);
          border-radius: 50%;
          background-repeat: no-repeat;
          pointer-events: none;
          z-index: 10000;
          background-color: var(--bg-primary);
          display: none;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        \`;
        document.body.appendChild(magnifierGlass);
        return magnifierGlass;
      }

      // Convert SVG to data URI
      function svgToDataUri(svg) {
        const clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        const svgStr = new XMLSerializer().serializeToString(clone);
        return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      }

      // Get image source for element
      function getImageSrc(el) {
        if (el.tagName === 'IMG') return el.src;
        if (el.tagName === 'svg' || el.tagName === 'SVG') return svgToDataUri(el);
        return null;
      }

      // Update magnifier position and content
      function updateMagnifier(e, target) {
        const glass = createMagnifier();
        const rect = target.getBoundingClientRect();
        const src = getImageSrc(target);
        if (!src) return;

        // Get dimensions
        const width = target.tagName === 'IMG' ? target.naturalWidth || target.width : rect.width;
        const height = target.tagName === 'IMG' ? target.naturalHeight || target.height : rect.height;

        const zoom = 2.5;
        const glassSize = 400;

        // Position magnifier at cursor (using fixed positioning)
        let x = e.clientX - glassSize / 2;
        let y = e.clientY - glassSize / 2;

        // Keep within viewport
        x = Math.max(10, Math.min(x, window.innerWidth - glassSize - 10));
        y = Math.max(10, Math.min(y, window.innerHeight - glassSize - 10));

        glass.style.left = x + 'px';
        glass.style.top = y + 'px';
        glass.style.backgroundImage = \`url('\${src}')\`;
        glass.style.backgroundSize = \`\${width * zoom}px \${height * zoom}px\`;

        // Background position based on cursor within element
        let bgX = ((e.clientX - rect.left) / rect.width) * 100;
        let bgY = ((e.clientY - rect.top) / rect.height) * 100;
        bgX = Math.max(0, Math.min(100, bgX));
        bgY = Math.max(0, Math.min(100, bgY));
        glass.style.backgroundPosition = \`\${bgX}% \${bgY}%\`;

        glass.style.display = 'block';
      }

      function hideMagnifier() {
        if (magnifierGlass) magnifierGlass.style.display = 'none';
      }

      // Keyboard handlers
      document.addEventListener('keydown', (e) => {
        if (e.key === 'z' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
          zKeyPressed = true;
        }
        if (e.key === 'Escape') {
          zKeyPressed = false;
          clickLocked = false;
          currentTarget = null;
          hideMagnifier();
        }
      });

      document.addEventListener('keyup', (e) => {
        if (e.key === 'z') {
          zKeyPressed = false;
          if (!clickLocked) hideMagnifier();
        }
      });

      // Mouse handlers on document for smooth tracking
      document.addEventListener('mousemove', (e) => {
        if (!zKeyPressed && !clickLocked) return;
        if (!currentTarget) return;
        updateMagnifier(e, currentTarget);
      });

      // Setup zoomable elements
      function setupZoomable(el) {
        if (el.hasAttribute('data-zoom-ready')) return;
        el.setAttribute('data-zoom-ready', 'true');
        el.style.cursor = 'zoom-in';

        el.addEventListener('mouseenter', () => {
          currentTarget = el;
        });

        el.addEventListener('mouseleave', () => {
          if (!clickLocked) {
            currentTarget = null;
            hideMagnifier();
          }
        });

        el.addEventListener('click', (e) => {
          if (e.target.closest('a')) return; // Don't block links
          clickLocked = !clickLocked;
          if (!clickLocked) {
            hideMagnifier();
          }
        });
      }

      // Find and setup all zoomable elements
      function enhanceAll() {
        // Images
        document.querySelectorAll('img:not([data-zoom-ready])').forEach(setupZoomable);
        // All SVGs in .mermaid containers (covers all diagram types)
        document.querySelectorAll('.mermaid svg:not([data-zoom-ready])').forEach(setupZoomable);
        // SVGs with mermaid IDs
        document.querySelectorAll('svg[id^="mermaid"]:not([data-zoom-ready])').forEach(setupZoomable);
        // SVGs with dmermaid IDs (some diagram types use this)
        document.querySelectorAll('svg[id^="dmermaid"]:not([data-zoom-ready])').forEach(setupZoomable);
        // Any SVG directly inside .mermaid that might have replaced the text
        document.querySelectorAll('.mermaid > svg:not([data-zoom-ready])').forEach(setupZoomable);
        // Architecture and other diagrams might use different structures
        document.querySelectorAll('[data-mermaid-type] svg:not([data-zoom-ready])').forEach(setupZoomable);
      }

      // Run after mermaid renders (architecture diagrams take longer)
      setTimeout(enhanceAll, 500);
      setTimeout(enhanceAll, 1000);
      setTimeout(enhanceAll, 2000);
      setTimeout(enhanceAll, 3000);
      setTimeout(enhanceAll, 5000);

      // Watch for dynamically added elements
      new MutationObserver(() => {
        setTimeout(enhanceAll, 100);
      }).observe(document.body, { childList: true, subtree: true });
    })();
  </script>
</body>
</html>`;
}

/**
 * Start multi-file development server
 */
export async function startServer(
  filePathOrPaths: string | string[],
  options: ServerOptions = {}
): Promise<{ server: ReturnType<typeof createServer>; port: number; addFile: (f: string) => Promise<FileInfo | null>; removeFile: (f: string) => void; switchFile: (f: string) => Promise<void> }> {
  const host = options.host || 'localhost';

  // Normalize to array
  const initialPaths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];

  // Determine base directory (common parent of all files)
  const baseDir = initialPaths.length === 1
    ? resolve(initialPaths[0], '..')
    : process.cwd();

  // Server state
  const state: ServerState = {
    files: new Map(),
    currentFile: null,
    baseDir,
  };

  // File watchers
  const watchers: Map<string, FSWatcher> = new Map();
  const clients = new Set<WebSocket>();

  async function validateFile(filePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const fullPath = resolve(filePath);
    if (!existsSync(fullPath)) {
      return { ok: false, error: `File not found: ${fullPath}` };
    }

    try {
      const markdown = readFileSync(fullPath, 'utf-8');
      await renderMarkdown(markdown);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  // Add a file to tracking. Rendering failures are file-local: bad files are
  // skipped instead of poisoning the whole preview session.
  async function addFile(filePath: string): Promise<FileInfo | null> {
    const fullPath = resolve(filePath);

    if (state.files.has(fullPath)) {
      return state.files.get(fullPath)!;
    }

    const validation = await validateFile(fullPath);
    if (!validation.ok) {
      console.error(`Skipping ${fullPath}: ${validation.error}`);
      broadcastError(fullPath, validation.error);
      return null;
    }

    const info: FileInfo = {
      path: fullPath,
      name: basename(fullPath),
      relativePath: relative(state.baseDir, fullPath) || basename(fullPath),
    };

    state.files.set(fullPath, info);

    // Set as current if first file
    if (!state.currentFile) {
      state.currentFile = fullPath;
    }

    // Watch the file
    if (options.watch) {
      const watcher = watch(fullPath, { persistent: true, ignoreInitial: true });
      watcher.on('change', async () => {
        const validation = await validateFile(fullPath);
        if (!validation.ok) {
          console.error(`Render failed for ${info.name}: ${validation.error}`);
          broadcastError(fullPath, validation.error);
          return;
        }

        console.log(`📝 File changed: ${info.name}`);
        broadcastReload();
      });
      watchers.set(fullPath, watcher);
    }

    console.log(`📁 Added file: ${info.name}`);
    broadcastFileList();
    return info;
  }

  // Remove a file from tracking
  function removeFile(filePath: string): void {
    const fullPath = resolve(filePath);
    if (!state.files.has(fullPath)) return;

    const info = state.files.get(fullPath)!;
    state.files.delete(fullPath);

    // Stop watching
    const watcher = watchers.get(fullPath);
    if (watcher) {
      watcher.close();
      watchers.delete(fullPath);
    }

    // Switch to another file if this was current
    if (state.currentFile === fullPath) {
      const remaining = Array.from(state.files.keys());
      state.currentFile = remaining.length > 0 ? remaining[0] : null;
    }

    console.log(`📁 Removed file: ${info.name}`);
    broadcastFileList();
    broadcastReload();
  }

  // Switch current file
  async function switchFile(filePath: string): Promise<void> {
    const fullPath = resolve(filePath);
    if (!state.files.has(fullPath)) {
      // Auto-add if not tracked; keep the current page if the new file fails.
      const added = await addFile(filePath);
      if (!added) return;
    }

    if (state.files.has(fullPath)) {
      state.currentFile = fullPath;
      console.log(`📄 Switched to: ${state.files.get(fullPath)!.name}`);
      broadcastReload();
    }
  }

  // Broadcast reload to all clients
  function broadcastReload(): void {
    const msg = JSON.stringify({ action: 'reload' });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }

  function broadcastError(file: string, error: string): void {
    const msg = JSON.stringify({ action: 'error', file, error });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }

  // Broadcast file list to all clients
  function broadcastFileList(): void {
    const files = Array.from(state.files.values()).map(f => ({
      path: f.path,
      name: f.name,
      active: f.path === state.currentFile,
    }));
    const msg = JSON.stringify({ action: 'files', files });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  }

  // Render current file
  async function renderCurrentFile(): Promise<string> {
    if (!state.currentFile || !state.files.has(state.currentFile)) {
      return '<h1>No file selected</h1><p>Add a markdown file to preview.</p>';
    }

    const currentInfo = state.files.get(state.currentFile)!;
    const allFiles = Array.from(state.files.values());

    try {
      const markdown = readFileSync(state.currentFile, 'utf-8');
      const html = await renderMarkdown(markdown);
      return generateHTMLTemplate(html, currentInfo, allFiles, state.baseDir);
    } catch (error: any) {
      return `<h1>Error</h1><pre>${error.message}</pre>`;
    }
  }

  function sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolvePromise, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolvePromise(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  function getCurrentDocumentPayload() {
    if (!state.currentFile || !state.files.has(state.currentFile)) {
      return null;
    }

    const snapshot = readDocument(state.currentFile);
    return {
      file: snapshot.path,
      hash: snapshot.hash,
      mtimeMs: snapshot.mtimeMs,
      content: snapshot.content,
      blocks: findMermaidBlocks(snapshot.content),
    };
  }

  function handleDocumentWriteError(res: ServerResponse, error: unknown): void {
    if (error instanceof DocumentConflictError) {
      sendJson(res, 409, { ok: false, error: error.message });
      return;
    }
    if (error instanceof RangeError) {
      sendJson(res, 404, { ok: false, error: error.message });
      return;
    }
    sendJson(res, 400, { ok: false, error: 'Invalid request' });
  }

  // Add initial files. Bad files are reported and skipped, leaving the
  // server alive so other files can still be previewed.
  for (const p of initialPaths) {
    await addFile(p);
  }

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/api/document/current') {
      const payload = getCurrentDocumentPayload();
      if (!payload) {
        sendJson(res, 404, { ok: false, error: 'No current document' });
        return;
      }
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/document/mermaid-blocks') {
      const payload = getCurrentDocumentPayload();
      if (!payload) {
        sendJson(res, 404, { ok: false, error: 'No current document' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        file: payload.file,
        hash: payload.hash,
        mtimeMs: payload.mtimeMs,
        blocks: payload.blocks,
      });
      return;
    }

    const mermaidBlockMatch = req.url?.match(/^\/api\/document\/mermaid-blocks\/(\d+)$/);
    if (req.method === 'POST' && mermaidBlockMatch) {
      try {
        if (!state.currentFile || !state.files.has(state.currentFile)) {
          sendJson(res, 404, { ok: false, error: 'No current document' });
          return;
        }

        const body = await readJsonBody(req);
        const blockIndex = Number(mermaidBlockMatch[1]);
        const snapshot = readDocument(state.currentFile);
        const nextContent = replaceMermaidBlock(snapshot.content, blockIndex, String(body.code ?? ''), body.meta);
        const nextSnapshot = writeDocumentIfUnchanged(state.currentFile, nextContent, {
          expectedHash: String(body.expectedHash ?? ''),
          expectedMtimeMs: typeof body.expectedMtimeMs === 'number' ? body.expectedMtimeMs : undefined,
        });
        broadcastReload();
        sendJson(res, 200, {
          ok: true,
          file: nextSnapshot.path,
          hash: nextSnapshot.hash,
          mtimeMs: nextSnapshot.mtimeMs,
          blocks: findMermaidBlocks(nextSnapshot.content),
        });
      } catch (error) {
        handleDocumentWriteError(res, error);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/document/mermaid-blocks') {
      try {
        if (!state.currentFile || !state.files.has(state.currentFile)) {
          sendJson(res, 404, { ok: false, error: 'No current document' });
          return;
        }

        const body = await readJsonBody(req);
        const snapshot = readDocument(state.currentFile);
        const nextContent = appendMermaidBlock(snapshot.content, String(body.code ?? ''), body.meta);
        const nextSnapshot = writeDocumentIfUnchanged(state.currentFile, nextContent, {
          expectedHash: String(body.expectedHash ?? ''),
          expectedMtimeMs: typeof body.expectedMtimeMs === 'number' ? body.expectedMtimeMs : undefined,
        });
        broadcastReload();
        sendJson(res, 201, {
          ok: true,
          file: nextSnapshot.path,
          hash: nextSnapshot.hash,
          mtimeMs: nextSnapshot.mtimeMs,
          blocks: findMermaidBlocks(nextSnapshot.content),
        });
      } catch (error) {
        handleDocumentWriteError(res, error);
      }
      return;
    }

    // API endpoint for adding files
    if (req.method === 'POST' && req.url === '/api/add') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { file } = JSON.parse(body);
          const added = await addFile(file);
          if (added) {
            state.currentFile = added.path;
            broadcastFileList();
            broadcastReload();
          }
          res.writeHead(added ? 200 : 422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(added ? { ok: true, file: added } : { ok: false, error: 'File could not be rendered and was skipped' }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
        }
      });
      return;
    }

    // API endpoint for removing files
    if (req.method === 'POST' && req.url === '/api/remove') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { file } = JSON.parse(body);
          removeFile(file);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
        }
      });
      return;
    }

    // API endpoint for file list
    if (req.url === '/api/files') {
      const files = Array.from(state.files.values());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files, current: state.currentFile }));
      return;
    }

    // Serve favicon
    if (req.url === '/favicon.svg') {
      try {
        const iconPath = resolve(__dirname, '../../assets/icons/favicon.svg');
        const iconData = readFileSync(iconPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=31536000',
        });
        res.end(iconData);
        return;
      } catch {
        res.writeHead(404);
        res.end('Favicon not found');
        return;
      }
    }

    // Serve font file
    if (req.url === '/fonts/DepartureMono-Regular.woff2') {
      try {
        const fontPath = resolve(__dirname, '../../assets/fonts/DepartureMono-Regular.woff2');
        const fontData = readFileSync(fontPath);
        res.writeHead(200, {
          'Content-Type': 'font/woff2',
          'Cache-Control': 'public, max-age=31536000',
        });
        res.end(fontData);
        return;
      } catch {
        res.writeHead(404);
        res.end('Font not found');
        return;
      }
    }

    // Main page
    const html = await renderCurrentFile();
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  });

  // Create WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send current file list on connect
    const files = Array.from(state.files.values()).map(f => ({
      path: f.path,
      name: f.name,
      active: f.path === state.currentFile,
    }));
    ws.send(JSON.stringify({ action: 'files', files }));

    ws.on('message', async (data: RawData) => {
      try {
        const msg: WsMessage = JSON.parse(data.toString());

        switch (msg.action) {
          case 'switch':
            if (msg.file) await switchFile(msg.file);
            break;
          case 'add':
            if (msg.file) await addFile(msg.file);
            break;
          case 'remove':
            if (msg.file) removeFile(msg.file);
            break;
          case 'list':
            const fileList = Array.from(state.files.values());
            ws.send(JSON.stringify({ action: 'files', files: fileList }));
            break;
        }
      } catch (e) {
        console.error('Invalid WS message:', e);
      }
    });

    ws.on('close', () => clients.delete(ws));
  });

  // Start listening
  return new Promise((resolvePromise) => {
    // Use port 0 to let OS assign if not specified
    const requestedPort = options.port ?? 0;

    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

      // Output port for nvim to parse
      console.log(`PORT:${actualPort}`);

      console.log(`
┌─────────────────────────────────────────┐
│  mdmaid dev server                      │
├─────────────────────────────────────────┤
│  URL:      http://${host}:${actualPort}${' '.repeat(Math.max(0, 5 - String(actualPort).length))}│
│  Files:    ${state.files.size} tracked${' '.repeat(20)}│
│  Watch:    ${options.watch ? '✓ enabled' : '✗ disabled'}${' '.repeat(14)}│
└─────────────────────────────────────────┘
      `);

      resolvePromise({
        server,
        port: actualPort,
        addFile,
        removeFile,
        switchFile,
      });
    });
  });
}
