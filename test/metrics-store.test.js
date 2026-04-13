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

describe('MetricsStore read API', function () {
    let store, dbPath;
    beforeEach(function () {
        dbPath = tempDbPath();
        store = new MetricsStore({ dbPath });
        store.open();
        const base = Date.now() - 1000 * 60 * 10;
        for (let i = 0; i < 10; i++) {
            const ts = base + i * 1000;
            store.flush({
                system: {
                    ts, proc_cpu_pct: i * 10, proc_rss: 1000 + i, proc_heap_used: 500,
                    proc_heap_total: 800, event_loop_lag: 1.0,
                    sys_cpu_pct: i * 5, sys_mem_used: 2000, sys_mem_total: 8000,
                    disk_used: 100, disk_total: 1000, container: 0
                },
                nodes: [
                    { node_id: 'n1', node_type: 'function', msg_count: i + 1, avg_process_ms: 1.5, error_count: 0, last_error_ts: null },
                    { node_id: 'n2', node_type: 'inject',   msg_count: 1,     avg_process_ms: 0.1, error_count: i % 3 === 0 ? 1 : 0, last_error_ts: i % 3 === 0 ? ts : null }
                ]
            });
        }
    });
    afterEach(function () {
        store.close();
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
        if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    });

    it('getRange raw returns rows within bounds', function () {
        const now = Date.now();
        const rows = store.getRange(now - 60_000 * 20, now);
        assert.strictEqual(rows.length, 10);
    });

    it('getRange with bucketMs groups via SQL', function () {
        const now = Date.now();
        const rows = store.getRange(now - 60_000 * 20, now, { bucketMs: 2000 });
        assert.ok(rows.length > 0 && rows.length < 10, 'bucketed rows should be fewer than raw');
        assert.ok('proc_cpu_pct' in rows[0], 'bucket rows expose avg columns');
    });

    it('getNodeStats returns only that node', function () {
        const now = Date.now();
        const rows = store.getNodeStats('n1', now - 60_000 * 20, now);
        assert.strictEqual(rows.length, 10);
        assert.ok(rows.every(r => r.node_id === 'n1'));
    });

    it('getTopNodes ranks by msg_count', function () {
        const now = Date.now();
        const top = store.getTopNodes(now - 60_000 * 20, now, { metric: 'msg_count', n: 5 });
        assert.strictEqual(top[0].node_id, 'n1');
    });

    it('getSummary returns min/max/avg/p95 for proc_cpu_pct', function () {
        const now = Date.now();
        const s = store.getSummary(60_000 * 20);
        assert.ok(s.proc_cpu_pct);
        assert.strictEqual(s.proc_cpu_pct.min, 0);
        assert.strictEqual(s.proc_cpu_pct.max, 90);
    });
});

describe('MetricsStore retention', function () {
    let store, dbPath;
    beforeEach(function () {
        dbPath = tempDbPath();
        store = new MetricsStore({ dbPath, retentionDays: 1 });
        store.open();
    });
    afterEach(function () {
        store.close();
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
        if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    });

    it('deletes samples older than retentionDays', function () {
        const now = Date.now();
        const old = now - 1000 * 60 * 60 * 48;
        store.flush({
            system: { ts: old, proc_cpu_pct: 1, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0, event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0, disk_used: 0, disk_total: 0, container: 0 },
            nodes: []
        });
        store.flush({
            system: { ts: now, proc_cpu_pct: 1, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0, event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0, disk_used: 0, disk_total: 0, container: 0 },
            nodes: []
        });
        assert.strictEqual(store._db.prepare('SELECT COUNT(*) c FROM samples').get().c, 2);

        const result = store.runRetention();
        assert.strictEqual(result.deletedSamples, 1);
        assert.strictEqual(store._db.prepare('SELECT COUNT(*) c FROM samples').get().c, 1);
    });

    it('emits "retention" event with counts', function () {
        const now = Date.now();
        store.flush({
            system: { ts: now - 1000 * 60 * 60 * 48, proc_cpu_pct: 1, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0, event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0, disk_used: 0, disk_total: 0, container: 0 },
            nodes: []
        });
        const seen = [];
        store.on('retention', p => seen.push(p));
        store.runRetention();
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].deletedSamples, 1);
    });
});

function baseSystem(ts) {
    return {
        ts, proc_cpu_pct: 0, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0,
        event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0,
        disk_used: 0, disk_total: 0, container: 0
    };
}
