import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import stringWidth from 'string-width';

import { renderMarkdownToTui } from 'mdmaid/tui';

const fixturePath = fileURLToPath(
  new URL('./fixtures/mixed-terminal.md', import.meta.url),
);
const fakeVeolPath = fileURLToPath(
  new URL('./fixtures/fake-veol', import.meta.url),
);
const fixture = readFileSync(fixturePath, 'utf8');
const hostileFixture = fixture
  .replaceAll('{{ESC}}', '\u001B')
  .replaceAll('{{BEL}}', '\u0007')
  .replaceAll('{{NUL}}', '\u0000');

const safeSgr = /\u001B\[(?:0|1|2|3|4|9|22|23|24|29|3[0-7]|39|90)m/g;
const anySgr = /\u001B\[[0-9;]*m/g;
const unsafeControl = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

function stripSgr(value) {
  return value.replace(anySgr, '');
}

function assertFitsWidth(output, width) {
  for (const [index, line] of output.split('\n').entries()) {
    assert.ok(
      stringWidth(stripSgr(line)) <= width,
      `line ${index + 1} exceeds ${width} cells: ${JSON.stringify(line)}`,
    );
  }
}

function assertOnlySafeSgr(output) {
  const withoutSafeSgr = output.replace(safeSgr, '');
  assert.doesNotMatch(withoutSafeSgr, unsafeControl);
  assert.doesNotMatch(withoutSafeSgr, /\u001B/u);
}

test('the in-process fallback richly renders a complete mixed Markdown document', async () => {
  const result = await renderMarkdownToTui(hostileFixture, {
    backend: 'beautiful-mermaid',
    color: false,
    unicode: true,
    width: 72,
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.doesNotMatch(result.output, /^#{1,6} /m);
  assert.doesNotMatch(result.output, /```|~~removed text~~/);
  assert.match(result.output, /Heading one/);
  assert.match(result.output, /Heading six/);
  assert.match(result.output, /inlineCode\(\)/);
  assert.match(
    result.output,
    /mdmaid documentation \(https:\/\/example\.com\/mdmaid\)/,
  );
  assert.match(result.output, /[•●] Unordered item/u);
  assert.match(result.output, /[☑✓] Completed task/u);
  assert.match(result.output, /1\. First ordered item/);
  assert.match(result.output, /^│ .*quoted paragraph/mu);
  assert.match(result.output, /^┌.*┬.*┐$/mu);
  assert.match(result.output, /^│ Element .*│/mu);
  assert.match(result.output, /┌─ typescript /u);
  assert.match(result.output, /mystery_call\("plain fallback"\);/);
  assert.match(result.output, /Start/);
  assert.match(result.output, /Finish/);
  assert.match(result.output, /pie/);
  assert.match(result.output, /Unsupported pets/);
  assert.match(
    result.warnings.join('\n'),
    /beautiful-mermaid.*could not render/i,
  );
  assert.doesNotMatch(result.output, /\u001B|\u0007|\u0000/u);
  assert.doesNotMatch(result.output, /\]52|SECRET|\[2J/);
  assertFitsWidth(result.output, 72);
});

test('narrow portable output uses ASCII borders and never overflows', async () => {
  const result = await renderMarkdownToTui(fixture, {
    backend: 'beautiful-mermaid',
    color: false,
    unicode: false,
    width: 24,
  });

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.doesNotMatch(result.output, /[┌┐└┘─│├┤┬┴┼•☑☐]/u);
  assert.match(result.output, /^\+- typescript -+\+$/m);
  assert.match(result.output, /^\+[-+]+\+$/m);
  assert.match(result.output, /^\| .*\|$/m);
  assert.match(result.output, /\[x\] Completed task/);
  assertFitsWidth(result.output, 24);
});

test('explicit color is deterministic, safe, and highlights only known languages', async () => {
  const options = {
    backend: 'beautiful-mermaid',
    color: true,
    unicode: true,
    width: 60,
  };
  const first = await renderMarkdownToTui(hostileFixture, options);
  const second = await renderMarkdownToTui(hostileFixture, options);
  const plain = await renderMarkdownToTui(hostileFixture, {
    ...options,
    color: false,
  });

  assert.equal(first.output, second.output);
  assert.match(first.output, /\u001B\[/u);
  assert.doesNotMatch(plain.output, /\u001B/u);
  assert.match(first.output, /\u001B\[[0-9;]*mconst\u001B\[/u);

  const unknownCodeLine = first.output
    .split('\n')
    .find((line) => line.includes('mystery_call'));
  assert.ok(unknownCodeLine);
  assert.doesNotMatch(unknownCodeLine, /\u001B/u);

  assertOnlySafeSgr(first.output);
  assert.doesNotMatch(first.output.replace(safeSgr, ''), /\]52|SECRET|\[2J/);
  assertFitsWidth(first.output, 60);
});

test('plain Markdown without Mermaid is still rendered by the in-process backend', async () => {
  const result = await renderMarkdownToTui(
    '# Plain document\n\nA **formatted** paragraph that wraps.\n',
    {
      backend: 'beautiful-mermaid',
      color: false,
      width: 28,
    },
  );

  assert.equal(result.backend, 'beautiful-mermaid');
  assert.doesNotMatch(result.output, /^# /m);
  assert.doesNotMatch(result.output, /\*\*formatted\*\*/);
  assert.match(result.output, /Plain document/);
  assert.match(result.output, /formatted/);
  assertFitsWidth(result.output, 28);
});

test('source and Veol paths strip hostile terminal controls', async () => {
  const source = await renderMarkdownToTui(hostileFixture, {
    backend: 'source',
  });

  assert.doesNotMatch(source.output, unsafeControl);
  assert.doesNotMatch(source.output, /\u001B|\]52|SECRET|\[2J/u);

  const veol = await renderMarkdownToTui(hostileFixture, {
    backend: 'veol',
    veolPath: fakeVeolPath,
    width: 48,
  });
  assert.equal(veol.backend, 'veol');
  assert.doesNotMatch(veol.output, unsafeControl);
  assert.doesNotMatch(veol.output, /\u001B|\]52|SECRET|\[2J/u);
});

test('all ESC and C1 terminal sequence families are removed', async () => {
  const hostile = [
    'before \u001B[31mred\u001B[0m after',
    'before \u001B]8;;https://evil.example\u0007link\u001B]8;;\u0007 after',
    'before \u009B2J after',
    'before \u001BPdevice-control\u001B\\ after',
    'before \u0090c1-device-control\u009C after',
    'before\t\u202Ehidden-bidi after',
    'before unterminated \u001B]52;c;clipboard-secret',
  ].join('\n');
  const result = await renderMarkdownToTui(hostile, { backend: 'source' });

  assert.match(result.output, /before red after/);
  assert.match(result.output, /before link after/);
  assert.match(result.output, /before {4}hidden-bidi after/);
  assert.doesNotMatch(
    result.output,
    /evil\.example|device-control|clipboard-secret|\u001B|[\u0090-\u009F]/u,
  );
});
