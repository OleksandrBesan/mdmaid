import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const cliPath = fileURLToPath(new URL('../bin/mdmaid.js', import.meta.url));
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'mdmaid-tui-cli-'));
const markdownPath = join(fixtureDirectory, 'document.md');

writeFileSync(
  markdownPath,
  '# CLI document\n\n```mermaid\ngraph LR\n  A --> B\n```\n',
);

after(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function runCli(args, input, env = process.env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env,
    input,
  });
}

test('tui renders a Markdown file to stdout with an explicit source backend', () => {
  const result = runCli(['tui', markdownPath, '--backend', 'source']);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    '# CLI document\n\n```mermaid\ngraph LR\n  A --> B\n```\n',
  );
  assert.equal(result.stderr, '');
});

test('render-mermaid reads stdin and prints actual terminal art', () => {
  const result = runCli(
    ['render-mermaid', '-', '--format', 'ascii', '--backend', 'beautiful-mermaid'],
    'graph LR\n  A --> B\n',
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /A/);
  assert.match(result.stdout, /B/);
  assert.doesNotMatch(result.stdout, /backend:|```mermaid|\{\s*output:/);
  assert.equal(result.stderr, '');
});

test('render-mermaid auto-falls back to terminal art when Veol is unavailable', () => {
  const result = runCli(
    ['render-mermaid', '-'],
    'graph LR\n  A --> B\n',
    { ...process.env, PATH: fixtureDirectory },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /A/);
  assert.match(result.stdout, /B/);
  assert.doesNotMatch(result.stdout, /```mermaid/);
  assert.match(result.stderr, /Warning: Veol executable not found/);
});

test('tui reads Markdown from stdin and replaces Mermaid fences', () => {
  const result = runCli(
    ['tui', '-', '--backend', 'beautiful-mermaid'],
    '# Pipe\n\n```mermaid\ngraph LR\n  A --> B\n```\n',
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^# Pipe/m);
  assert.doesNotMatch(result.stdout, /```mermaid/);
  assert.match(result.stdout, /A/);
  assert.match(result.stdout, /B/);
});

test('show --viewer tui routes through the terminal renderer', () => {
  const result = runCli([
    'show',
    markdownPath,
    '--viewer',
    'tui',
    '--backend',
    'source',
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^# CLI document/m);
  assert.doesNotMatch(result.stdout, /<h1/);
});

test('show --viewer web retains the existing HTML renderer', () => {
  const result = runCli(['show', markdownPath, '--viewer', 'web']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /<h1 id="cli-document">.*CLI document<\/h1>/);
});

test('the default command retains the existing HTML renderer', () => {
  const result = runCli([markdownPath]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /<h1 id="cli-document">.*CLI document<\/h1>/);
});

test('the CLI rejects an invalid TUI backend', () => {
  const result = runCli(['tui', markdownPath, '--backend', 'unknown']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid backend/);
});

test('the CLI rejects widths below Veol minimum', () => {
  const result = runCli(['tui', markdownPath, '--width', '10']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /width.*20/i);
});

test('the CLI rejects unsupported render-mermaid formats', () => {
  const result = runCli(['render-mermaid', markdownPath, '--format', 'svg']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /supports only ascii/);
});

test('the CLI rejects invalid viewers', () => {
  const result = runCli(['show', markdownPath, '--viewer', 'terminal-ish']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid viewer/);
});

test('help documents the terminal commands', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /mdmaid tui <file\|->/);
  assert.match(result.stdout, /mdmaid render-mermaid <file\|->/);
  assert.match(result.stdout, /--viewer <type>/);
});
