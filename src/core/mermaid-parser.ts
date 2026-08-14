import { Worker } from 'node:worker_threads';

interface MermaidParseResult {
  diagramType: string;
}

interface SerializedError {
  name: string;
  message: string;
  hash?: unknown;
}

interface WorkerResponse {
  id: number;
  result?: MermaidParseResult;
  error?: SerializedError;
}

interface PendingRequest {
  resolve: (result: MermaidParseResult) => void;
  reject: (error: Error) => void;
}

let parser: MermaidParser | undefined;

export function parseMermaidSyntax(code: string): Promise<MermaidParseResult> {
  parser ??= new MermaidParser();
  return parser.parse(code);
}

class MermaidParser {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #worker: Worker;
  #nextId = 0;
  #stopped = false;

  constructor() {
    this.#worker = new Worker(
      new URL('./mermaid-parser-worker.js', import.meta.url),
    );
    this.#worker.unref();
    this.#worker.on('message', (response: WorkerResponse) => {
      this.#settle(response);
    });
    this.#worker.on('error', (error) => {
      this.#stop(error);
    });
    this.#worker.on('exit', (code) => {
      this.#stop(
        code === 0
          ? new Error('Mermaid parser worker exited unexpectedly.')
          : new Error(`Mermaid parser worker exited with code ${code}.`),
      );
    });
  }

  parse(code: string): Promise<MermaidParseResult> {
    if (this.#stopped) {
      return Promise.reject(new Error('Mermaid parser worker is unavailable.'));
    }

    const id = this.#nextId++;
    this.#worker.ref();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ id, code });
      } catch (error) {
        this.#pending.delete(id);
        if (this.#pending.size === 0) this.#worker.unref();
        reject(error);
      }
    });
  }

  #settle(response: WorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (this.#pending.size === 0) this.#worker.unref();

    if (response.error) {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      if (response.error.hash !== undefined) {
        Object.assign(error, { hash: response.error.hash });
      }
      pending.reject(error);
      return;
    }

    if (!response.result) {
      pending.reject(new Error('Mermaid parser worker returned no result.'));
      return;
    }

    pending.resolve(response.result);
  }

  #stop(error: Error): void {
    if (this.#stopped) return;
    this.#stopped = true;
    parser = undefined;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    this.#worker.unref();
  }
}
