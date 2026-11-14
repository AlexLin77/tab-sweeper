import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, HOUR, MINUTE, formatDuration, hostOf, plural } from '../src/format.js';

test('formatDuration', () => {
  assert.equal(formatDuration(0), '<1m');
  assert.equal(formatDuration(59_999), '<1m');
  assert.equal(formatDuration(NaN), '<1m');
  assert.equal(formatDuration(12 * MINUTE + 30_000), '12m');
  assert.equal(formatDuration(3 * HOUR), '3h');
  assert.equal(formatDuration(3 * HOUR + 5 * MINUTE), '3h 5m');
  assert.equal(formatDuration(2 * DAY), '2d');
  assert.equal(formatDuration(2 * DAY + 4 * HOUR + 59 * MINUTE), '2d 4h');
});

test('hostOf', () => {
  assert.equal(hostOf('https://www.github.com/a/b'), 'github.com');
  assert.equal(hostOf('http://localhost:8080/'), 'localhost');
  assert.equal(hostOf('chrome://settings/privacy'), 'chrome://settings');
  assert.equal(hostOf('file:///Users/me/notes.txt'), 'Local file');
  assert.equal(hostOf('about:blank'), 'about');
  assert.equal(hostOf('nonsense'), '');
});

test('plural', () => {
  assert.equal(plural(1, 'tab'), '1 tab');
  assert.equal(plural(0, 'tab'), '0 tabs');
  assert.equal(plural(3, 'duplicate'), '3 duplicates');
});
