import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { localDateSuffix, datedJsonlStem } = require('../plugin/storage/jsonl-filename.cjs');
test('date suffix uses local calendar and follows the original PDF name', () => {
  const suffix = localDateSuffix(new Date(2026, 9, 30, 23, 59));
  assert.equal(suffix, '261030');
  assert.equal(datedJsonlStem('12_books/原则.pdf', suffix), '12_books/原则261030');
  assert.equal(datedJsonlStem('12_books/改名.pdf', suffix), '12_books/改名261030');
  assert.throws(() => datedJsonlStem('a.pdf', '20261030'));
});
