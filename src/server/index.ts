import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, statSync, readdirSync } from 'fs';
import { resolve, extname, basename } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { watch } from 'chokidar';
import { renderMarkdown } from '../core/renderer';

export interface ServerOptions {
  port?: number;
  watch?: boolean;
  host?: string;
}

interface TocItem {
  id: string;
  text: string;
  level: number;
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
 * Generate HTML template with TOC and Magnifier
 */
function generateHTMLTemplate(content: string, title: string, filePath: string): string {
  const toc = extractTOC(content);

  const tocHTML = toc.length > 0 ? `
    <nav class="toc">
      <div class="toc-header">Content Tree</div>
      <ul class="toc-list">
        ${toc.map(item => `
          <li class="toc-item toc-level-${item.level}">
            <a href="#${item.id}">${item.text}</a>
          </li>
        `).join('')}
      </ul>
    </nav>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>

  <!-- Mermaid -->
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      securityLevel: 'loose'
    });
  </script>

  <!-- Highlight.js for code syntax highlighting -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>hljs.highlightAll();</script>

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #24292e;
      background: #f6f8fa;
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 20px;
      padding: 20px;
      min-height: 100vh;
    }

    /* Table of Contents */
    .toc {
      position: sticky;
      top: 20px;
      height: fit-content;
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      max-height: calc(100vh - 40px);
      overflow-y: auto;
    }

    .toc-header {
      font-weight: 600;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #586069;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e1e4e8;
    }

    .toc-list {
      list-style: none;
    }

    .toc-item {
      margin: 4px 0;
    }

    .toc-item a {
      display: block;
      padding: 4px 8px;
      text-decoration: none;
      color: #24292e;
      border-radius: 4px;
      font-size: 13px;
      transition: all 0.2s;
    }

    .toc-item a:hover {
      background: #f6f8fa;
      color: #0366d6;
    }

    .toc-level-1 { padding-left: 0; font-weight: 600; }
    .toc-level-2 { padding-left: 12px; }
    .toc-level-3 { padding-left: 24px; font-size: 12px; }
    .toc-level-4 { padding-left: 36px; font-size: 12px; }
    .toc-level-5 { padding-left: 48px; font-size: 11px; }
    .toc-level-6 { padding-left: 60px; font-size: 11px; }

    /* Main Content */
    .content {
      background: white;
      border-radius: 8px;
      padding: 40px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      max-width: 900px;
      position: relative;
    }

    .content h1, .content h2, .content h3,
    .content h4, .content h5, .content h6 {
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
      line-height: 1.25;
    }

    .content h1 { font-size: 2em; border-bottom: 1px solid #e1e4e8; padding-bottom: 8px; }
    .content h2 { font-size: 1.5em; border-bottom: 1px solid #e1e4e8; padding-bottom: 8px; }
    .content h3 { font-size: 1.25em; }

    .content p { margin: 16px 0; }
    .content ul, .content ol { margin: 16px 0; padding-left: 2em; }
    .content li { margin: 4px 0; }

    .content a {
      color: #0366d6;
      text-decoration: none;
    }

    .content a:hover {
      text-decoration: underline;
    }

    /* Code blocks */
    .content pre {
      background: #f6f8fa;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid #e1e4e8;
    }

    .content code {
      background: #f6f8fa;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'SF Mono', Monaco, Consolas, 'Courier New', monospace;
      font-size: 0.9em;
    }

    .content pre code {
      background: none;
      padding: 0;
      font-size: 0.85em;
    }

    /* Mermaid diagrams */
    .content .mermaid {
      margin: 24px 0;
      text-align: center;
      cursor: zoom-in;
    }

    /* Magnifier styles */
    .magnifier-container {
      position: relative;
      display: inline-block;
    }

    .magnifier-glass {
      position: fixed;
      width: 200px;
      height: 200px;
      border: 3px solid #0366d6;
      border-radius: 50%;
      cursor: none;
      pointer-events: none;
      z-index: 1000;
      display: none;
      background: white;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      overflow: hidden;
    }

    .magnifier-glass img {
      position: absolute;
      transform-origin: top left;
    }

    /* File path header */
    .file-path {
      position: relative;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 12px;
      color: #586069;
      background: #f6f8fa;
      padding: 8px 12px;
      border-radius: 4px;
      margin-bottom: 20px;
      border-left: 3px solid #0366d6;
    }

    /* Live reload indicator */
    .live-indicator {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #28a745;
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      z-index: 1000;
    }

    .live-indicator.disconnected {
      background: #dc3545;
    }

    .help-indicator {
      position: fixed;
      bottom: 20px;
      left: 20px;
      background: rgba(0,0,0,0.7);
      color: white;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 11px;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      z-index: 1000;
    }

    .help-indicator kbd {
      background: rgba(255,255,255,0.2);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 10px;
      margin: 0 2px;
    }

    /* Print button */
    .print-button {
      position: absolute;
      top: 8px;
      right: 12px;
      background: transparent;
      border: none;
      color: #586069;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.28em;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: all 0.2s;
    }

    .print-button:hover {
      background: #f6f8fa;
      color: #24292e;
    }

    /* Print styles */
    @media print {
      body {
        background: white;
        grid-template-columns: 1fr;
        padding: 0;
      }

      .toc, .live-indicator, .help-indicator, .print-button {
        display: none !important;
      }

      .content {
        box-shadow: none;
        border-radius: 0;
        max-width: 100%;
        padding: 20px;
      }

      .file-path {
        border: 1px solid #e1e4e8;
      }

      .mermaid {
        page-break-inside: avoid;
      }

      pre {
        page-break-inside: avoid;
      }

      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid;
      }
    }

    @media (max-width: 768px) {
      body {
        grid-template-columns: 1fr;
      }

      .toc {
        position: static;
        max-height: 300px;
      }
    }
  </style>
</head>
<body>
  ${tocHTML}

  <div class="content">
    <div class="file-path">
      📄 ${filePath}
      <button class="print-button" onclick="window.print()" title="Print this page">[print]</button>
    </div>
    ${content}
  </div>

  <div class="magnifier-glass" id="magnifier"></div>
  <div class="live-indicator" id="live-indicator">● Live</div>
  <div class="help-indicator">
    Magnifier: Hold <kbd>Z</kbd> or Click image | <kbd>ESC</kbd> to close
  </div>

  <script>
    // Magnifier functionality (improved from oles.md)
    function initMagnifier() {
      console.log('🔍 Initializing magnifier...');
      let zKeyPressed = false;
      let clickMagnifierActive = false;
      let currentHoveredImage = null;
      let lastMouseEvent = null;
      const allMagnifierGlasses = [];

      const handleKeyDown = (e) => {
        if (e.key === 'z' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          console.log('🔑 Z key pressed');

          const target = e.target;
          const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
          if (isInput) return;

          zKeyPressed = true;
          if (currentHoveredImage) {
            currentHoveredImage.setAttribute('data-magnifier-active', 'true');
            if (lastMouseEvent) {
              currentHoveredImage.dispatchEvent(new MouseEvent('mousemove', {
                clientX: lastMouseEvent.clientX,
                clientY: lastMouseEvent.clientY,
                bubbles: true
              }));
            }
          }
        }

        if (e.key === 'Escape') {
          e.preventDefault();
          zKeyPressed = false;
          clickMagnifierActive = false;
          if (currentHoveredImage) {
            currentHoveredImage.removeAttribute('data-magnifier-active');
          }
          allMagnifierGlasses.forEach((glass) => {
            if (glass && glass.parentNode) {
              glass.style.display = 'none';
            }
          });
        }
      };

      const handleKeyUp = (e) => {
        if (e.key === 'z') {
          zKeyPressed = false;
          if (currentHoveredImage) {
            currentHoveredImage.removeAttribute('data-magnifier-active');
          }
          allMagnifierGlasses.forEach((glass) => {
            if (glass && glass.parentNode) {
              glass.style.display = 'none';
            }
          });
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);

      const enhanceImages = () => {
        // Try multiple selectors to find images
        const images = document.querySelectorAll('img:not([data-no-zoom])');
        console.log('🖼️ Found images:', images.length);
        console.log('🔍 All img elements:', document.querySelectorAll('img').length);
        console.log('🔍 Content div exists:', !!document.querySelector('.content'));

        images.forEach((img) => {
          console.log('📸 Enhancing image:', img.src || img.getAttribute('src'));
          if (img.hasAttribute('data-magnifier-processed')) return;
          img.setAttribute('data-magnifier-processed', 'true');

          img.style.cursor = 'zoom-in';
          img.style.transition = 'transform 0.2s';

          let magnifierGlass = null;

          const showMagnifier = (e) => {
            lastMouseEvent = e;
            if (!zKeyPressed && !clickMagnifierActive) return;
            console.log('👁️ Showing magnifier');

            const target = img;
            const rect = target.getBoundingClientRect();

            if (!magnifierGlass) {
              magnifierGlass = document.createElement('div');
              magnifierGlass.style.position = 'absolute';
              magnifierGlass.style.width = '450px';
              magnifierGlass.style.height = '450px';
              magnifierGlass.style.border = '3px solid #fff';
              magnifierGlass.style.borderRadius = '50%';
              magnifierGlass.style.boxShadow = '0 0 15px rgba(0,0,0,0.7)';
              magnifierGlass.style.backgroundRepeat = 'no-repeat';
              magnifierGlass.style.pointerEvents = 'none';
              magnifierGlass.style.zIndex = '10000';
              magnifierGlass.style.backgroundColor = '#f0f0f0';

              // Get the image src, handling both img elements and inline SVGs
              let imgSrc = target.src || target.getAttribute('src');
              if (imgSrc) {
                magnifierGlass.style.backgroundImage = \`url("\${imgSrc}")\`;
              }

              document.body.appendChild(magnifierGlass);
              allMagnifierGlasses.push(magnifierGlass);
            }

            const zoom = 2.5;
            const glassSize = 450;

            // Calculate desired position
            let x = e.pageX - glassSize / 2;
            let y = e.pageY - glassSize / 2;

            // Keep magnifier glass within viewport bounds
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const scrollX = window.pageXOffset;
            const scrollY = window.pageYOffset;

            // Clamp to viewport with some padding
            const padding = 10;
            x = Math.max(scrollX + padding, Math.min(x, scrollX + viewportWidth - glassSize - padding));
            y = Math.max(scrollY + padding, Math.min(y, scrollY + viewportHeight - glassSize - padding));

            magnifierGlass.style.left = x + 'px';
            magnifierGlass.style.top = y + 'px';
            magnifierGlass.style.display = 'block';

            // Calculate position relative to image
            let bgX = ((e.clientX - rect.left) / rect.width) * 100;
            let bgY = ((e.clientY - rect.top) / rect.height) * 100;

            // Clamp to 0-100% to lock to edges when outside bounds
            bgX = Math.max(0, Math.min(100, bgX));
            bgY = Math.max(0, Math.min(100, bgY));

            const bgSize = \`\${target.width * zoom}px \${target.height * zoom}px\`;
            magnifierGlass.style.backgroundSize = bgSize;
            magnifierGlass.style.backgroundPosition = \`\${bgX}% \${bgY}%\`;
          };

          const hideMagnifier = () => {
            if (magnifierGlass) {
              magnifierGlass.style.display = 'none';
            }
          };

          const removeMagnifier = () => {
            if (magnifierGlass) {
              const index = allMagnifierGlasses.indexOf(magnifierGlass);
              if (index > -1) {
                allMagnifierGlasses.splice(index, 1);
              }
              magnifierGlass.remove();
              magnifierGlass = null;
            }
          };

          const globalMouseMove = (e) => {
            lastMouseEvent = e;
            if ((!zKeyPressed && !clickMagnifierActive) || currentHoveredImage !== img) return;
            showMagnifier(e);
          };

          const handleClick = (e) => {
            e.preventDefault();
            clickMagnifierActive = !clickMagnifierActive;
            if (clickMagnifierActive) {
              showMagnifier(e);
            } else {
              hideMagnifier();
            }
          };

          img.addEventListener('mouseenter', (e) => {
            console.log('🐭 Mouse entered image');
            currentHoveredImage = img;
            lastMouseEvent = e;
            img.addEventListener('mousemove', showMagnifier);
            document.addEventListener('mousemove', globalMouseMove);
          });

          img.addEventListener('mouseleave', (e) => {
            if (!clickMagnifierActive) {
              const rect = img.getBoundingClientRect();
              const buffer = 200;
              const inBufferZone =
                e.clientX >= rect.left - buffer &&
                e.clientX <= rect.right + buffer &&
                e.clientY >= rect.top - buffer &&
                e.clientY <= rect.bottom + buffer;

              if (!inBufferZone) {
                currentHoveredImage = null;
                img.removeAttribute('data-magnifier-active');
                img.removeEventListener('mousemove', showMagnifier);
                document.removeEventListener('mousemove', globalMouseMove);
                hideMagnifier();
              }
            }
          });

          img.addEventListener('click', handleClick);

          const cleanupObserver = new MutationObserver(() => {
            if (!document.body.contains(img)) {
              removeMagnifier();
              cleanupObserver.disconnect();
            }
          });
          cleanupObserver.observe(document.body, { childList: true, subtree: true });
        });
      };

      enhanceImages();

      const observer = new MutationObserver(() => {
        enhanceImages();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // Listen for manual re-enhance trigger
      window.addEventListener('reenhance', () => {
        console.log('🔄 Re-enhancing images...');
        enhanceImages();
      });
    }

    // Initialize immediately and after mermaid renders
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initMagnifier);
    } else {
      initMagnifier();
    }

    // Also run after a delay to catch late-loading content
    setTimeout(() => {
      console.log('⏰ Re-running enhancer after delay...');
      const event = new Event('reenhance');
      window.dispatchEvent(event);
    }, 2000);

    // WebSocket for live reload
    const ws = new WebSocket('ws://' + location.host);
    const indicator = document.getElementById('live-indicator');

    ws.onopen = () => {
      indicator.textContent = '● Live';
      indicator.classList.remove('disconnected');
    };

    ws.onclose = () => {
      indicator.textContent = '● Disconnected';
      indicator.classList.add('disconnected');
    };

    ws.onmessage = (event) => {
      if (event.data === 'reload') {
        location.reload();
      }
    };

    // Smooth scroll for TOC links
    document.querySelectorAll('.toc a').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const id = link.getAttribute('href').substring(1);
        const element = document.getElementById(id);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });

          // Highlight clicked item
          document.querySelectorAll('.toc a').forEach(a => a.style.background = '');
          link.style.background = '#f6f8fa';
        }
      });
    });
  </script>
</body>
</html>`;
}

/**
 * Start development server
 */
export async function startServer(filePath: string, options: ServerOptions = {}) {
  const port = options.port || 3333;
  const host = options.host || 'localhost';
  const fullPath = resolve(filePath);

  let currentHTML = '';

  // Render initial content
  async function renderFile() {
    try {
      const markdown = readFileSync(fullPath, 'utf-8');
      const html = await renderMarkdown(markdown);
      const title = basename(filePath, extname(filePath));
      currentHTML = generateHTMLTemplate(html, title, filePath);
      return currentHTML;
    } catch (error: any) {
      return `<h1>Error</h1><pre>${error.message}</pre>`;
    }
  }

  await renderFile();

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(currentHTML);
  });

  // Create WebSocket server
  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  // Watch for file changes
  if (options.watch) {
    const watcher = watch(fullPath, {
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('change', async () => {
      console.log(`📝 File changed: ${filePath}`);
      await renderFile();

      // Notify all connected clients
      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send('reload');
        }
      });

      console.log(`🔄 Reloaded ${clients.size} client(s)`);
    });
  }

  server.listen(port, host, () => {
    console.log(`
┌─────────────────────────────────────────┐
│  mdmaid dev server                      │
├─────────────────────────────────────────┤
│  URL:      http://${host}:${port}     │
│  File:     ${filePath}                  │
│  Watch:    ${options.watch ? '✓ enabled' : '✗ disabled'}              │
│  Features: ✓ TOC  ✓ Magnifier  ✓ Live  │
└─────────────────────────────────────────┘
    `);
  });

  return server;
}
