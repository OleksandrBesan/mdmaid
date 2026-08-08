import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  renderMarkdownToTui,
  renderMermaidToAscii,
} from 'mdmaid/tui';

const fakeVeolPath = fileURLToPath(
  new URL('./fixtures/fake-veol', import.meta.url),
);
const missingVeolPath = fileURLToPath(
  new URL('./fixtures/does-not-exist', import.meta.url),
);

test('renderMarkdownToTui preserves Markdown through the source backend', async () => {
  const markdown = '# Hello\n\nA terminal-safe document.\n';

  const result = await renderMarkdownToTui(markdown, { backend: 'source' });

  assert.deepEqual(result, {
    output: markdown,
    backend: 'source',
    warnings: [],
  });
});

test('renderMermaidToAscii preserves Mermaid code in a fenced source block', async () => {
  const code = 'graph LR\n  A --> B';

  const result = await renderMermaidToAscii(code, { backend: 'source' });

  assert.deepEqual(result, {
    output: '```mermaid\ngraph LR\n  A --> B\n```',
    backend: 'source',
    warnings: [],
  });
});

test('renderMermaidToAscii does not add a blank line before the closing fence', async () => {
  const result = await renderMermaidToAscii('graph LR\n  A --> B\n', {
    backend: 'source',
  });

  assert.equal(result.output, '```mermaid\ngraph LR\n  A --> B\n```');
});

test('renderMarkdownToTui sends Markdown to Veol through stdin', async () => {
  const markdown = '# Veol document\n';

  const result = await renderMarkdownToTui(markdown, {
    backend: 'veol',
    veolPath: fakeVeolPath,
    width: 72,
  });

  assert.deepEqual(result, {
    output: 'VEOL width=72\n# Veol document\n',
    backend: 'veol',
    warnings: [],
  });
});

test('renderMermaidToAscii renders Unicode terminal art with beautiful-mermaid', async () => {
  const result = await renderMermaidToAscii('graph LR\n  A --> B', {
    backend: 'beautiful-mermaid',
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.match(result.output, /A/);
  assert.match(result.output, /B/);
  assert.doesNotMatch(result.output, /```mermaid/);
});

test('renderMermaidToAscii supports portable pure ASCII output', async () => {
  const result = await renderMermaidToAscii('graph LR\n  A --> B', {
    backend: 'beautiful-mermaid',
    unicode: false,
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.doesNotMatch(result.output, /[┌┐└┘─│▶]/u);
});

test('auto falls back from a missing Veol binary to beautiful-mermaid', async () => {
  const result = await renderMermaidToAscii('graph LR\n  A --> B', {
    backend: 'auto',
    veolPath: missingVeolPath,
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.match(result.warnings.join('\n'), /Veol.*not found/i);
  assert.doesNotMatch(result.output, /```mermaid/);
});

test('an explicit Veol backend falls back to source when Veol fails', async () => {
  const code = 'graph LR\n  A --> B';

  const result = await renderMermaidToAscii(code, {
    backend: 'veol',
    veolPath: missingVeolPath,
  });

  assert.equal(result.backend, 'source');
  assert.match(result.warnings.join('\n'), /Veol.*not found/i);
  assert.equal(result.output, `\`\`\`mermaid\n${code}\n\`\`\``);
});

test('the Markdown fallback richly renders Markdown around Mermaid diagrams', async () => {
  const markdown = [
    '# Mixed document',
    '',
    'Before.',
    '',
    '```mermaid',
    'graph LR',
    '  A --> B',
    '```',
    '',
    '```js',
    'console.log("preserved");',
    '```',
    '',
  ].join('\n');

  const result = await renderMarkdownToTui(markdown, {
    backend: 'beautiful-mermaid',
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.doesNotMatch(result.output, /^# Mixed document/m);
  assert.match(result.output, /Mixed document/);
  assert.match(result.output, /Before\./);
  assert.doesNotMatch(result.output, /```mermaid/);
  assert.match(result.output, /A/);
  assert.match(result.output, /B/);
  assert.doesNotMatch(result.output, /```js/);
  assert.match(result.output, /console\.log\("preserved"\);/);
});

test('auto preserves source when Veol is missing and the JS fallback is disabled', async () => {
  const markdown = '# Source only\n';

  const result = await renderMarkdownToTui(markdown, {
    backend: 'auto',
    veolPath: missingVeolPath,
    beautifulMermaid: false,
  });

  assert.equal(result.backend, 'source');
  assert.equal(result.output, markdown);
  assert.match(result.warnings.join('\n'), /Veol.*not found/i);
});

test('beautiful-mermaid preserves unsupported diagrams with a warning', async () => {
  const code = 'pie\n  title Pets\n  "Dogs": 1';

  const result = await renderMermaidToAscii(code, {
    backend: 'beautiful-mermaid',
  });

  assert.equal(result.backend, 'source');
  assert.equal(result.output, `\`\`\`mermaid\n${code}\n\`\`\``);
  assert.match(result.warnings.join('\n'), /beautiful-mermaid.*could not render/i);
});

test('the Markdown fallback richly renders documents without Mermaid', async () => {
  const markdown = '# Plain Markdown\n\n- one\n- two\n';

  const result = await renderMarkdownToTui(markdown, {
    backend: 'beautiful-mermaid',
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.deepEqual(result.warnings, []);
  assert.doesNotMatch(result.output, /^# Plain Markdown/m);
  assert.doesNotMatch(result.output, /^- one/m);
  assert.match(result.output, /Plain Markdown/);
  assert.match(result.output, /one/);
  assert.match(result.output, /two/);
});

test('the Markdown fallback boxes unsupported Mermaid source', async () => {
  const markdown = '~~~mermaid\npie\n  "Dogs": 1\n~~~\n';

  const result = await renderMarkdownToTui(markdown, {
    backend: 'beautiful-mermaid',
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.doesNotMatch(result.output, /~~~mermaid/);
  assert.match(result.output, /mermaid/);
  assert.match(result.output, /pie/);
  assert.match(result.output, /"Dogs": 1/);
  assert.match(result.warnings.join('\n'), /beautiful-mermaid.*could not render/i);
});

test('Veol nonzero exits become warnings and source fallback', async () => {
  const markdown = 'VEOL_FAIL\n';

  const result = await renderMarkdownToTui(markdown, {
    backend: 'veol',
    veolPath: fakeVeolPath,
  });

  assert.equal(result.backend, 'source');
  assert.equal(result.output, markdown);
  assert.match(result.warnings.join('\n'), /exit code 2.*intentional Veol failure/i);
});

test('Veol width is clamped to its documented minimum', async () => {
  const result = await renderMarkdownToTui('# Width\n', {
    backend: 'veol',
    veolPath: fakeVeolPath,
    width: 1,
  });

  assert.match(result.output, /^VEOL width=20$/m);
});

test('renderMermaidToAscii can use Veol as the selected backend', async () => {
  const result = await renderMermaidToAscii('graph LR\n  A --> B', {
    backend: 'veol',
    veolPath: fakeVeolPath,
    width: 88,
  });

  assert.equal(result.backend, 'veol');
  assert.match(result.output, /^VEOL width=88$/m);
  assert.match(result.output, /```mermaid/);
});

test('source fallback selects a safe fence when Mermaid contains backticks', async () => {
  const result = await renderMermaidToAscii('graph LR\n  A[```] --> B', {
    backend: 'source',
  });

  assert.match(result.output, /^````mermaid/);
  assert.match(result.output, /\n````$/);
});
