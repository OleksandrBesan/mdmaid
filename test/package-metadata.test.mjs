import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

test('npm repository metadata matches the GitHub provenance repository', () => {
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/riidii-md/mdmaid.git',
  );
});
