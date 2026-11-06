'use strict';

// A plain Node script so the fixture needs no install, no package manager and no network.
// Exits 0 when everything holds, 1 otherwise, with one line per check on stdout.

const assert = require('node:assert');
const { parseStamp, formatStamp, addMinutes, minutesBetween } = require('../src/time.js');

const checks = [
  ['a timestamp is taken apart', () => {
    assert.deepStrictEqual(parseStamp('2026-03-02T09:05'), { year: 2026, month: 3, day: 2, hour: 9, minute: 5 });
  }],
  ['a timestamp written out is zero-padded, so it reads back', () => {
    const written = formatStamp({ year: 2026, month: 3, day: 2, hour: 9, minute: 5 });
    assert.strictEqual(written, '2026-03-02T09:05');
    assert.deepStrictEqual(parseStamp(written), { year: 2026, month: 3, day: 2, hour: 9, minute: 5 });
  }],
  ['adding minutes crosses midnight and the end of the month', () => {
    assert.strictEqual(addMinutes('2026-02-28T23:50', 20), '2026-03-01T00:10');
    assert.strictEqual(addMinutes('2026-03-02T09:00', -30), '2026-03-02T08:30');
  }],
  ['the minutes between two timestamps', () => {
    assert.strictEqual(minutesBetween('2026-03-02T09:00', '2026-03-02T10:30'), 90);
    assert.strictEqual(minutesBetween('2026-03-02T10:30', '2026-03-02T09:00'), -90);
  }],
  ['a timestamp that does not exist is refused', () => {
    assert.throws(() => parseStamp('2026-02-30T09:00'), /exists/);
    assert.throws(() => parseStamp('2026-3-2T9:00'), /timestamp/);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}: ${error.message}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
