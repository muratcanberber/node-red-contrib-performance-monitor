const assert = require('assert');
const { SECTIONS } = require('../src/editor/sidebar/sections');
const sample = {
  nodeRed: { cpu: 12.5, memory: { rss: 100, heapUsed: 50, heapTotal: 80, external: 4, arrayBuffers: 1 }, eventLoopLag: 2.0, pid: 1, uptime: 3600 },
  system: { cpu: { percent: 40, cores: 8, model: 'x' }, memory: { total: 100, used: 60, free: 40, usedPercent: 60 }, disk: { total: 100, used: 30, free: 70, usedPercent: 30 } },
};
describe('editor/sections', function () {
  it('defines app + sys sections in order', function () {
    const ids = SECTIONS.map((s) => s.id);
    assert.ok(ids.includes('app-cpu') && ids.includes('app-memory') && ids.includes('app-lag'));
    assert.ok(ids.includes('sys-cpu') && ids.includes('sys-memory') && ids.includes('sys-disk'));
  });
  it('accessors compute values from stats', function () {
    const cpu = SECTIONS.find((s) => s.id === 'app-cpu');
    assert.strictEqual(cpu.percent(sample), 12.5);
    assert.match(cpu.value(sample), /12\.5/);
    const sysMem = SECTIONS.find((s) => s.id === 'sys-memory');
    assert.strictEqual(sysMem.percent(sample), 60);
  });
});
