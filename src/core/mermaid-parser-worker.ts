import { parentPort } from 'node:worker_threads';

import { JSDOM } from 'jsdom';

interface ParseRequest {
  id: number;
  code: string;
}

interface SerializedError {
  name: string;
  message: string;
  hash?: unknown;
}

if (!parentPort) {
  throw new Error('The Mermaid parser worker requires a parent port.');
}
const port = parentPort;

// Mermaid's Node entry imports DOMPurify as though a browser window already
// exists. Keep that browser-like global inside this worker so library consumers
// do not have their own globalThis.window changed by validation.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mdmaid.invalid/',
});
Object.defineProperty(globalThis, 'window', {
  configurable: false,
  value: dom.window,
  writable: false,
});

const { default: mermaid } = await import('mermaid');
mermaid.initialize({
  securityLevel: 'strict',
  startOnLoad: false,
});

let queue = Promise.resolve();

port.on('message', (request: ParseRequest) => {
  queue = queue.then(async () => {
    try {
      const result = await mermaid.parse(request.code);
      port.postMessage({ id: request.id, result });
    } catch (error) {
      const value = error as { hash?: unknown; message?: unknown; name?: unknown };
      const serialized: SerializedError = {
        name: typeof value?.name === 'string' ? value.name : 'Error',
        message:
          typeof value?.message === 'string' ? value.message : String(error),
      };
      if (value?.hash !== undefined) serialized.hash = value.hash;
      port.postMessage({ id: request.id, error: serialized });
    }
  });
});
