// test/editor-format.test.js
const assert = require('assert');
const { formatBytes, formatUptime, statusClass, lagStatusClass } = require('../src/editor/format');

describe('editor/format', function () {
  it('formatBytes', function () {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(1024), '1 KB');
    assert.strictEqual(formatBytes(1536, 1), '1.5 KB');
    assert.strictEqual(formatBytes(1048576), '1 MB');
  });
  it('formatUptime', function () {
    assert.strictEqual(formatUptime(30), '0m');
    assert.strictEqual(formatUptime(3600), '1h 0m');
    assert.strictEqual(formatUptime(90061), '1d 1h 1m');
  });
  it('statusClass thresholds', function () {
    assert.strictEqual(statusClass(10), 'pm-ok');
    assert.strictEqual(statusClass(75), 'pm-warn');
    assert.strictEqual(statusClass(95), 'pm-crit');
  });
  it('lagStatusClass thresholds', function () {
    assert.strictEqual(lagStatusClass(5), 'pm-ok');
    assert.strictEqual(lagStatusClass(30), 'pm-warn');
    assert.strictEqual(lagStatusClass(80), 'pm-crit');
  });
});
