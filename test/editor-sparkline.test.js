const assert = require('assert');
const { sparkline } = require('../src/editor/sparkline');
const RingBuffer = require('../src/editor/ring-buffer');

describe('editor/sparkline', function () {
  it('returns an svg with a polyline sized to opts', function () {
    const svg = sparkline([0, 1, 2, 3], { width: 100, height: 20 });
    assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
    assert.match(svg, /width="100"/);
    assert.match(svg, /<polyline/);
  });
  it('handles empty / single point without throwing', function () {
    assert.doesNotThrow(() => sparkline([], {}));
    assert.doesNotThrow(() => sparkline([5], {}));
  });
});
describe('editor/ring-buffer', function () {
  it('keeps only the last N values', function () {
    const rb = new RingBuffer(3);
    [1, 2, 3, 4, 5].forEach((v) => rb.push(v));
    assert.deepStrictEqual(rb.values(), [3, 4, 5]);
  });
});
