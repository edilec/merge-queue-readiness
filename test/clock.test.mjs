import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('evaluation and CLI clock calls are injected rather than read in-line', () => {
  for (const file of ['../src/index.mjs', '../bin/merge-queue-readiness.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Date\.now\(\)/);
  }
});
