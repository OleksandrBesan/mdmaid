import { spawn } from 'node:child_process';

import type { TuiRenderOptions } from '../types.js';

const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 20;
const MAX_WIDTH = 1_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface VeolAttempt {
  output?: string;
  warning?: string;
}

function resolveWidth(width: number | undefined): number {
  const candidate = width ?? process.stdout.columns ?? DEFAULT_WIDTH;

  if (!Number.isFinite(candidate)) {
    return DEFAULT_WIDTH;
  }

  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(candidate)));
}

function describeSpawnError(error: NodeJS.ErrnoException, veolPath: string): string {
  if (error.code === 'ENOENT') {
    return `Veol executable not found: ${veolPath}`;
  }

  return `Veol failed to start: ${error.message}`;
}

export function renderWithVeol(
  markdown: string,
  options: TuiRenderOptions,
): Promise<VeolAttempt> {
  const veolPath = options.veolPath ?? 'veol';
  const width = resolveWidth(options.width);

  return new Promise((resolve) => {
    const child = spawn(
      veolPath,
      ['--plain', '--width', String(width), '-'],
      {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;

    const finish = (attempt: VeolAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attempt);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ warning: `Veol timed out after ${TIMEOUT_MS / 1_000} seconds.` });
    }, TIMEOUT_MS);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;

      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish({ warning: 'Veol output exceeded the 10 MiB safety limit.' });
        return;
      }

      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled || errorBytes >= MAX_OUTPUT_BYTES) return;

      const remainingBytes = MAX_OUTPUT_BYTES - errorBytes;
      const captured = chunk.subarray(0, remainingBytes);
      errorBytes += captured.length;
      stderr.push(captured);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ warning: describeSpawnError(error, veolPath) });
    });

    child.on('close', (code, signal) => {
      if (settled) return;

      if (code === 0) {
        finish({ output: Buffer.concat(stdout).toString('utf8') });
        return;
      }

      const detail = Buffer.concat(stderr).toString('utf8').trim();
      const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      finish({
        warning: `Veol failed with ${status}${detail ? `: ${detail}` : '.'}`,
      });
    });

    child.stdin.on('error', () => {
      // Spawn/exit handlers provide the structured warning.
    });
    child.stdin.end(markdown);
  });
}
