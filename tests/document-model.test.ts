import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DocumentConflictError,
  appendMermaidBlock,
  findMermaidBlocks,
  hashContent,
  parseMdmaidDirective,
  readDocument,
  replaceMermaidBlock,
  serializeMdmaidDirective,
  writeDocumentIfUnchanged,
} from '../src/core/document';

describe('document model', () => {
  it('finds Mermaid blocks and ignores non-Mermaid fences', () => {
    const markdown = [
      '# Demo',
      '',
      '```ts',
      'console.log("nope")',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["Start"] --> B["End"]',
      '```',
      '',
      '```mermaid',
      '%% mdmaid:diagram id=auth-flow type=flowchart version=1',
      'flowchart LR',
      '  U["User"] --> O["OAuth"]',
      '```',
    ].join('\n');

    const blocks = findMermaidBlocks(markdown);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ index: 0, startLine: 7, endLine: 10 });
    expect(blocks[0].code).toBe('flowchart TD\n  A["Start"] --> B["End"]');
    expect(blocks[1]).toMatchObject({
      index: 1,
      id: 'auth-flow',
      type: 'flowchart',
      startLine: 12,
      endLine: 16,
      meta: { id: 'auth-flow', type: 'flowchart', version: '1' },
    });
    expect(blocks[1].code).toBe('flowchart LR\n  U["User"] --> O["OAuth"]');
  });

  it('parses and serializes mdmaid directives', () => {
    expect(parseMdmaidDirective('%% mdmaid:diagram id=auth-flow type=flowchart version=1')).toEqual({
      id: 'auth-flow',
      type: 'flowchart',
      version: '1',
    });

    expect(serializeMdmaidDirective({ id: 'auth-flow', type: 'flowchart', version: '1' })).toBe(
      '%% mdmaid:diagram id=auth-flow type=flowchart version=1'
    );
  });

  it('replaces a Mermaid block and inserts metadata when missing', () => {
    const markdown = ['before', '', '```mermaid', 'flowchart TD', '  A --> B', '```', '', 'after'].join('\n');

    const next = replaceMermaidBlock(markdown, 0, 'flowchart LR\n  C["New"] --> D["End"]', {
      id: 'new-flow',
      type: 'flowchart',
      version: '1',
    });

    expect(next).toBe(
      [
        'before',
        '',
        '```mermaid',
        '%% mdmaid:diagram id=new-flow type=flowchart version=1',
        'flowchart LR',
        '  C["New"] --> D["End"]',
        '```',
        '',
        'after',
      ].join('\n')
    );
  });

  it('replaces a Mermaid block and updates existing metadata', () => {
    const markdown = [
      '```mermaid',
      '%% mdmaid:diagram id=old type=flowchart version=1',
      'flowchart TD',
      '  A --> B',
      '```',
    ].join('\n');

    const next = replaceMermaidBlock(markdown, 0, 'flowchart TD\n  X --> Y', {
      id: 'new',
      type: 'flowchart',
      version: '2',
    });

    expect(next).toBe(
      [
        '```mermaid',
        '%% mdmaid:diagram id=new type=flowchart version=2',
        'flowchart TD',
        '  X --> Y',
        '```',
      ].join('\n')
    );
  });

  it('appends a new Mermaid block with metadata', () => {
    const markdown = '# Demo\n';

    expect(
      appendMermaidBlock(markdown, 'flowchart TD\n  A --> B', {
        id: 'new-flow',
        type: 'flowchart',
        version: '1',
      })
    ).toBe(
      [
        '# Demo',
        '',
        '```mermaid',
        '%% mdmaid:diagram id=new-flow type=flowchart version=1',
        'flowchart TD',
        '  A --> B',
        '```',
        '',
      ].join('\n')
    );
  });

  it('reads document snapshots and refuses stale guarded writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdmaid-doc-'));
    const file = join(dir, 'doc.md');
    writeFileSync(file, '# First\n', 'utf8');

    const snapshot = readDocument(file);
    expect(snapshot.content).toBe('# First\n');
    expect(snapshot.hash).toBe(hashContent('# First\n'));
    expect(snapshot.mtimeMs).toBe(statSync(file).mtimeMs);

    writeDocumentIfUnchanged(file, '# Second\n', { expectedHash: snapshot.hash });
    expect(readFileSync(file, 'utf8')).toBe('# Second\n');

    expect(() =>
      writeDocumentIfUnchanged(file, '# Third\n', { expectedHash: snapshot.hash })
    ).toThrow(DocumentConflictError);
  });
});
