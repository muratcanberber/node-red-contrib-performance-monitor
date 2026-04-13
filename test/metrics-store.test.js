const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const MetricsStore = require('../lib/metrics-store');

function tempDbPath() {
    return path.join(os.tmpdir(), `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('MetricsStore', function () {
    let store;
    let dbPath;

    beforeEach(function () {
        dbPath = tempDbPath();
        store = new MetricsStore({ dbPath });
        store.open();
    });

    afterEach(function () {
        store.close();
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
        if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    });

    it('applies WAL mode on open', function () {
        const mode = store._db.prepare('PRAGMA journal_mode').get();
        assert.strictEqual(mode.journal_mode, 'wal');
    });

    it('flushes a system sample', function () {
        const ts = Date.now();
        store.flush({
            system: {
                ts,
                proc_cpu_pct: 12.5, proc_rss: 1000, proc_heap_used: 500, proc_heap_total: 800,
                event_loop_lag: 1.2,
                sys_cpu_pct: 40, sys_mem_used: 2000, sys_mem_total: 8000,
                disk_used: 100, disk_total: 1000, container: 0
            },
            nodes: []
        });
        const recent = store.getRecent(10);
        assert.strictEqual(recent.length, 1);
        assert.strictEqual(recent[0].ts, ts);
        assert.strictEqual(recent[0].proc_cpu_pct, 12.5);
    });

    it('flushes per-node samples and skips zero-activity rows', function () {
        const ts = Date.now();
        store.flush({
            system: baseSystem(ts),
            nodes: [
                { node_id: 'a', node_type: 'function', msg_count: 5, avg_process_ms: 1.1, error_count: 0, last_error_ts: null },
                { node_id: 'b', node_type: 'inject',   msg_count: 0, avg_process_ms: 0,   error_count: 0, last_error_ts: null },
                { node_id: 'c', node_type: 'http in',  msg_count: 0, avg_process_ms: 0,   error_count: 2, last_error_ts: ts }
            ]
        });
        const rows = store._db.prepare('SELECT node_id FROM node_samples ORDER BY node_id').all();
        assert.deepStrictEqual(rows.map(r => r.node_id), ['a', 'c']);
    });

    it('flushes atomically (all or nothing)', function () {
        const ts = Date.now();
        assert.throws(() => {
            store.flush({
                system: baseSystem(ts),
                nodes: [
                    { node_id: 'a', node_type: 'function', msg_count: 1, avg_process_ms: 1, error_count: 0, last_error_ts: null },
                    { node_id: null, node_type: 'broken', msg_count: 1, avg_process_ms: 1, error_count: 0, last_error_ts: null }
                ]
            });
        });
        const recent = store.getRecent(10);
        assert.strictEqual(recent.length, 0, 'sample row must not persist when node insert fails');
    });
});

function baseSystem(ts) {
    return {
        ts, proc_cpu_pct: 0, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0,
        event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0,
        disk_used: 0, disk_total: 0, container: 0
    };
}
