import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname, basename, relative } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { watch, FSWatcher } from 'chokidar';
import { renderMarkdown } from '../core/renderer';

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
          <li class="file-item ${f.path === currentFile.path ? 'active' : ''}" data-file="${f.path}">
            <span class="file-icon">📄</span>
            <span class="file-name">${f.name}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  ` : '';

  const tocHTML = toc.length > 0 ? `
    <div class="toc-section">
      <div class="section-header">Contents</div>
      <ul class="toc-list">
        ${toc.map(item => `
          <li class="toc-item toc-level-${item.level}">
            <a href="#${item.id}">${item.text}</a>
          </li>
        `).join('')}
      </ul>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${currentFile.name} - mdmaid</title>

  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      securityLevel: 'loose',
      fontFamily: '"Departure Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 11,
      themeVariables: {
        primaryColor: '#ffffff',
        primaryTextColor: '#000000',
        primaryBorderColor: '#000000',
        lineColor: '#000000',
        secondaryColor: '#f5f5f5',
        tertiaryColor: '#e5e5e5',
        background: 'transparent',
        mainBkg: 'transparent',
        nodeBorder: '#000000',
        clusterBkg: '#f5f5f5',
        clusterBorder: '#000000',
        titleColor: '#000000',
        edgeLabelBackground: 'transparent',
      }
    });
  </script>

  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>hljs.highlightAll();</script>

  <style>
    @font-face {
      font-family: 'Departure Mono';
      src: url('https://cdn.jsdelivr.net/gh/nicowesse/Departure-Mono@1.422/fonts/webfonts/DepartureMono-Regular.woff2') format('woff2');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --font-mono: 'Departure Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace;
      --bg-primary: #ffffff;
      --bg-secondary: #f6f8fa;
      --text-primary: #000000;
      --text-secondary: #586069;
      --border-color: #e1e4e8;
      --accent-color: #000000;
    }

    body {
      font-family: var(--font-mono);
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
    }

    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      font-family: var(--font-mono);
      font-size: 0.9em;
    }

    .content pre code {
      background: none;
      padding: 0;
      font-size: 11px;
    }

    .content .mermaid {
      margin: 24px 0;
      text-align: center;
      background: transparent !important;
    }

    .content .mermaid svg {
      background: transparent !important;
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
    }

    @media (max-width: 768px) {
      body { grid-template-columns: 1fr; }
      .sidebar { position: static; flex-direction: row; flex-wrap: wrap; }
      .files-section, .toc-section { flex: 1; min-width: 200px; }
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

  <div class="status-bar">
    <div class="status-indicator file-count" id="file-count">${allFiles.length} file${allFiles.length !== 1 ? 's' : ''}</div>
    <div class="status-indicator live-indicator" id="live-indicator">● Live</div>
  </div>

  <script>
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
        }
      } catch {
        // Legacy: plain text reload message
        if (event.data === 'reload') {
          location.reload();
        }
      }
    };

    // File switching via sidebar click
    document.querySelectorAll('.file-item').forEach(item => {
      item.addEventListener('click', () => {
        const file = item.dataset.file;
        if (file) {
          ws.send(JSON.stringify({ action: 'switch', file }));
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
): Promise<{ server: ReturnType<typeof createServer>; port: number; addFile: (f: string) => void; removeFile: (f: string) => void; switchFile: (f: string) => void }> {
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

  // Add a file to tracking
  function addFile(filePath: string): FileInfo | null {
    const fullPath = resolve(filePath);
    if (!existsSync(fullPath)) {
      console.error(`File not found: ${fullPath}`);
      return null;
    }

    if (state.files.has(fullPath)) {
      return state.files.get(fullPath)!;
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
  function switchFile(filePath: string): void {
    const fullPath = resolve(filePath);
    if (!state.files.has(fullPath)) {
      // Auto-add if not tracked
      addFile(filePath);
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

  // Add initial files
  for (const p of initialPaths) {
    addFile(p);
  }

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // API endpoint for adding files
    if (req.method === 'POST' && req.url === '/api/add') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { file } = JSON.parse(body);
          addFile(file);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end('Invalid request');
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

    ws.on('message', (data) => {
      try {
        const msg: WsMessage = JSON.parse(data.toString());

        switch (msg.action) {
          case 'switch':
            if (msg.file) switchFile(msg.file);
            break;
          case 'add':
            if (msg.file) addFile(msg.file);
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
