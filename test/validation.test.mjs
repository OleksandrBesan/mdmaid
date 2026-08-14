import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMarkdown, validateMermaid } from 'mdmaid';
import { validateMarkdownWithAdapters } from '../dist/core/validation.js';

const validDocument = [
  '# Valid document',
  '',
  '```mermaid',
  'graph LR',
  '  A --> B',
  '```',
  '',
  '~~~mermaid',
  'sequenceDiagram',
  '  A->>B: Safe message',
  '~~~',
  '',
].join('\n');

const semicolonDocument = [
  '# Broken sequence',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  BE->>APP: UPSERT by (team, user, coaSession); allocate turnId',
  '```',
  '',
].join('\n');

test('validateMarkdown accepts Markdown whose Mermaid diagrams all parse', async () => {
  const result = await validateMarkdown(validDocument);

  assert.equal(result.valid, true);
  assert.equal(result.mode, 'parse');
  assert.deepEqual(result.markdown, { valid: true });
  assert.equal(result.diagrams.length, 2);
  assert.deepEqual(
    result.diagrams.map((diagram) => ({
      index: diagram.index,
      valid: diagram.valid,
      parsed: diagram.parsed,
      rendered: diagram.rendered,
      startLine: diagram.location.start.line,
    })),
    [
      { index: 0, valid: true, parsed: true, rendered: null, startLine: 3 },
      { index: 1, valid: true, parsed: true, rendered: null, startLine: 8 },
    ],
  );
  assert.deepEqual(result.diagnostics, []);
});

test('parse mode supports Mermaid syntax paths that sanitize labels', async () => {
  const document = [
    '```mermaid',
    'graph LR',
    '  A[Start] --> B[Finish]',
    '```',
    '',
    '```mermaid',
    'pie title Pets',
    '  "Dogs" : 2',
    '  "Cats" : 1',
    '```',
    '',
  ].join('\n');

  const result = await validateMarkdown(document);

  assert.equal(result.valid, true);
  assert.equal(result.diagrams.length, 2);
  assert.ok(result.diagrams.every(({ parsed }) => parsed));
});

test('parse mode does not install a browser window in the SDK caller', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'window');

  await validateMermaid('graph LR\n  A[Start] --> B[Finish]');

  assert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, 'window'),
    before,
  );
});

test('concurrent SDK validations share the isolated parser safely', async () => {
  const results = await Promise.all([
    validateMermaid('graph LR\n  A[One] --> B[Two]'),
    validateMermaid('pie title Pets\n  "Dogs" : 2'),
    validateMermaid('sequenceDiagram\n  A->>B: Safe message'),
  ]);

  assert.ok(results.every(({ valid, parsed }) => valid && parsed));
});

test('validateMarkdown reports the sequence-label semicolon at its absolute Markdown line', async () => {
  const result = await validateMarkdown(semicolonDocument);

  assert.equal(result.valid, false);
  assert.equal(result.markdown.valid, true);
  assert.equal(result.diagrams.length, 1);
  assert.equal(result.diagrams[0].diagramType, 'sequenceDiagram');
  assert.equal(result.diagrams[0].parsed, false);
  assert.equal(result.diagrams[0].valid, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'MERMAID_PARSE_ERROR');
  assert.equal(result.diagnostics[0].kind, 'content');
  assert.equal(result.diagnostics[0].stage, 'parse');
  assert.equal(result.diagnostics[0].diagramIndex, 0);
  assert.equal(result.diagnostics[0].location.start.line, 5);
  assert.ok(result.diagnostics[0].location.start.column > 1);
  assert.match(result.diagnostics[0].message, /Parse error on line 2/);
});

test('validation continues after one invalid diagram', async () => {
  const document = `${semicolonDocument}\n\n\`\`\`mermaid\ngraph TD\n  C --> D\n\`\`\`\n`;
  const result = await validateMarkdown(document);

  assert.equal(result.valid, false);
  assert.equal(result.diagrams.length, 2);
  assert.equal(result.diagrams[0].valid, false);
  assert.equal(result.diagrams[1].valid, true);
});

test('validateMermaid validates standalone diagram source', async () => {
  const valid = await validateMermaid('graph LR\n  A --> B');
  const invalid = await validateMermaid(
    'sequenceDiagram\n  A->>B: first; second',
  );

  assert.equal(valid.valid, true);
  assert.equal(valid.location.start.line, 1);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.diagnostics[0].code, 'MERMAID_PARSE_ERROR');
  assert.equal(invalid.diagnostics[0].location.start.line, 2);
});

test('unclosed fenced code is a Markdown structural error', async () => {
  const result = await validateMarkdown(
    '# Unclosed\n\n```mermaid\ngraph LR\n  A --> B\n',
  );

  assert.equal(result.valid, false);
  assert.equal(result.markdown.valid, false);
  assert.equal(result.diagrams[0].parsed, true);
  const diagnostic = result.diagnostics.find(
    ({ code }) => code === 'MARKDOWN_UNCLOSED_FENCE',
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.stage, 'markdown');
  assert.equal(diagnostic.location.start.line, 3);
});

test('diagram size limits fail safely without invoking Mermaid', async () => {
  let parseCalls = 0;
  const result = await validateMarkdownWithAdapters(
    '```mermaid\ngraph LR\n  A --> B\n```\n',
    { maxDiagramCharacters: 5 },
    {
      parse: async () => {
        parseCalls += 1;
        return { diagramType: 'flowchart-v2' };
      },
      renderBatch: async () => [],
    },
  );

  assert.equal(parseCalls, 0);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'MERMAID_SIZE_LIMIT');
});

test('document and diagram-count limits stop excess work with structured errors', async () => {
  const documentLimit = await validateMarkdown('too large', {
    maxMarkdownCharacters: 3,
  });
  const diagramLimit = await validateMarkdownWithAdapters(
    validDocument,
    { maxDiagrams: 1 },
    {
      parse: async () => ({ diagramType: 'flowchart-v2' }),
      renderBatch: async () => [],
    },
  );

  assert.equal(documentLimit.valid, false);
  assert.equal(documentLimit.markdown.valid, false);
  assert.equal(documentLimit.diagnostics[0].code, 'MARKDOWN_SIZE_LIMIT');
  assert.equal(diagramLimit.valid, false);
  assert.equal(diagramLimit.diagrams.length, 1);
  assert.equal(diagramLimit.diagrams[0].parsed, true);
  assert.equal(diagramLimit.diagnostics[0].code, 'MERMAID_DIAGRAM_LIMIT');
});

test('untrusted Mermaid errors cannot inject terminal controls into diagnostics', async () => {
  const hostile =
    '```mermaid\nnot-a-diagram \u001B]52;c;SECRET\u0007 visible\n```\n';
  const result = await validateMarkdown(hostile);
  const serialized = JSON.stringify(result);

  assert.equal(result.valid, false);
  assert.doesNotMatch(serialized, /\u001B|\u0007|SECRET/u);
  assert.match(serialized, /MERMAID_PARSE_ERROR/);
});

test('unknown diagram source cannot forge a diagnostic line number', async () => {
  const result = await validateMermaid('not-a-diagram line 999999');

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'MERMAID_PARSE_ERROR');
  assert.equal(result.diagnostics[0].location.start.line, 1);
});

test('unexpected Mermaid parser failures are runtime errors, not invalid content', async () => {
  const result = await validateMarkdownWithAdapters(
    '```mermaid\ngraph LR\n  A[Start] --> B[Finish]\n```\n',
    {},
    {
      parse: async () => {
        throw new TypeError('DOMPurify.addHook is not a function');
      },
      renderBatch: async () => [],
    },
  );

  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'MERMAID_PARSE_RUNTIME_ERROR');
  assert.equal(result.diagnostics[0].kind, 'runtime');
  assert.equal(result.diagrams[0].parsed, false);
});

test('render mode succeeds only after every parsed diagram returns SVG', async () => {
  const result = await validateMarkdownWithAdapters(
    validDocument,
    { mermaid: 'render' },
    {
      parse: async () => ({ diagramType: 'flowchart-v2' }),
      renderBatch: async (codes) => codes.map(() => '<svg></svg>'),
    },
  );

  assert.equal(result.valid, true);
  assert.ok(
    result.diagrams.every(
      ({ valid, parsed, rendered }) => valid && parsed && rendered,
    ),
  );
  assert.deepEqual(result.diagnostics, []);
});

test('render mode records per-diagram browser render failures', async () => {
  const result = await validateMarkdownWithAdapters(
    validDocument,
    { mermaid: 'render' },
    {
      parse: async (code) => ({
        diagramType: code.startsWith('graph') ? 'flowchart-v2' : 'sequence',
      }),
      renderBatch: async () => [
        '<svg role="graphics-document"></svg>',
        'Error: browser layout failed \u001B]52;c;SECRET\u0007',
      ],
    },
  );

  assert.equal(result.valid, false);
  assert.equal(result.mode, 'render');
  assert.equal(result.diagrams[0].rendered, true);
  assert.equal(result.diagrams[0].valid, true);
  assert.equal(result.diagrams[1].rendered, false);
  assert.equal(result.diagrams[1].valid, false);
  const diagnostic = result.diagrams[1].diagnostics[0];
  assert.equal(diagnostic.code, 'MERMAID_RENDER_ERROR');
  assert.equal(diagnostic.kind, 'content');
  assert.doesNotMatch(diagnostic.message, /\u001B|SECRET/u);
});

test('render mode distinguishes browser runtime failure from invalid content', async () => {
  const result = await validateMarkdownWithAdapters(
    validDocument,
    { mermaid: 'render' },
    {
      parse: async () => ({ diagramType: 'flowchart-v2' }),
      renderBatch: async () => {
        throw new Error('Browser unavailable \u001B]52;c;SECRET\u0007');
      },
    },
  );

  assert.equal(result.valid, false);
  assert.ok(result.diagrams.every(({ rendered }) => rendered === null));
  const diagnostic = result.diagnostics.find(
    ({ code }) => code === 'MERMAID_RENDER_RUNTIME_ERROR',
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.kind, 'runtime');
  assert.doesNotMatch(diagnostic.message, /\u001B|SECRET/u);
});

test('render mode treats an incomplete browser batch as a runtime failure', async () => {
  const result = await validateMarkdownWithAdapters(
    validDocument,
    { mermaid: 'render' },
    {
      parse: async () => ({ diagramType: '' }),
      renderBatch: async () => ['<svg></svg>'],
    },
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some(
      ({ code, message }) =>
        code === 'MERMAID_RENDER_RUNTIME_ERROR' &&
        /1 results for 2 diagrams/.test(message),
    ),
  );
  assert.equal(result.diagrams[0].diagramType, 'graph');
});

test('an empty non-SVG browser result becomes a readable content diagnostic', async () => {
  const result = await validateMarkdownWithAdapters(
    '```mermaid\ngraph LR\n  A --> B\n```\n',
    { mermaid: 'render' },
    {
      parse: async () => ({ diagramType: 'flowchart-v2' }),
      renderBatch: async () => [''],
    },
  );

  assert.equal(result.valid, false);
  assert.equal(result.diagrams[0].rendered, false);
  assert.equal(
    result.diagrams[0].diagnostics[0].message,
    'Mermaid did not return SVG output.',
  );
});
