const assert = require('assert');
const sinon = require('sinon');
const engine = require('../lib/storage/sqlite-engine');
const MetricsStore = require('../lib/metrics-store');

describe('storage load resilience', function () {
    afterEach(function () { sinon.restore(); });

    it('degrades (does not throw) when the engine cannot open a database', function () {
        sinon.stub(engine, 'openDatabase').throws(new Error('node:sqlite is not available in this runtime'));
        const store = new MetricsStore({ dbPath: '/tmp/whatever-pm.db' });
        let degradedEvent = null;
        store.on('store:degraded', e => { degradedEvent = e; });

        assert.doesNotThrow(() => store.openOrDegrade());
        assert.strictEqual(store.isDegraded(), true);
        assert.ok(degradedEvent && /node:sqlite/.test(degradedEvent.error));

        // It still accepts samples in memory and serves recent reads.
        const ts = Date.now();
        store.flush({ system: { ts, proc_cpu_pct: 1, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0, event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0, disk_used: 0, disk_total: 0, container: 0 }, nodes: [] });
        assert.strictEqual(store.getRecent(10).length, 1);
        store.close();
    });
});
