const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MetricsStore = require('../lib/metrics-store');

function tempDbPath() {
    return path.join(
        os.tmpdir(),
        `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
}

function cleanupDbFiles(dbPath) {
    const filePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

    for (const filePath of filePaths) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}

function baseSystem(ts, overrides = {}) {
    return Object.assign({
        ts: ts,
        proc_cpu_pct: 0,
        proc_rss: 0,
        proc_heap_used: 0,
        proc_heap_total: 0,
        event_loop_lag: 0,
        sys_cpu_pct: 0,
        sys_mem_used: 0,
        sys_mem_total: 0,
        disk_used: 0,
        disk_total: 0,
        container: 0
    }, overrides);
}

describe('MetricsStore', function () {
    let store;
    let dbPath;

    beforeEach(function () {
        dbPath = tempDbPath();
        store = new MetricsStore({ dbPath: dbPath });
        store.open();
    });

    afterEach(function () {
        store.close();
        cleanupDbFiles(dbPath);
    });

    it('applies WAL mode on open', function () {
        const mode = store._db.prepare('PRAGMA journal_mode').get();

        assert.strictEqual(mode.journal_mode, 'wal');
    });

    it('flushes a system sample', function () {
        const ts = Date.now();

        store.flush({
            system: baseSystem(ts, {
                proc_cpu_pct: 12.5,
                proc_rss: 1000,
                proc_heap_used: 500,
                proc_heap_total: 800,
                event_loop_lag: 1.2,
                sys_cpu_pct: 40,
                sys_mem_used: 2000,
                sys_mem_total: 8000,
                disk_used: 100,
                disk_total: 1000
            }),
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
                { node_id: 'b', node_type: 'inject', msg_count: 0, avg_process_ms: 0, error_count: 0, last_error_ts: null },
                { node_id: 'c', node_type: 'http in', msg_count: 0, avg_process_ms: 0, error_count: 2, last_error_ts: ts }
            ]
        });

        const rows = store._db.prepare('SELECT node_id FROM node_samples ORDER BY node_id').all();

        assert.deepStrictEqual(rows.map(function (row) {
            return row.node_id;
        }), ['a', 'c']);
    });

    it('flushes atomically (all or nothing)', function () {
        const ts = Date.now();

        assert.throws(function () {
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
    let store;
    let dbPath;

    beforeEach(function () {
        dbPath = tempDbPath();
        store = new MetricsStore({ dbPath: dbPath });
        store.open();

        const baseTs = Math.floor((Date.now() - 1000 * 60 * 10) / 10000) * 10000;

        for (let index = 0; index < 10; index += 1) {
            const ts = baseTs + index * 1000;

            store.flush({
                system: baseSystem(ts, {
                    proc_cpu_pct: index * 10,
                    proc_rss: 1000 + index,
                    proc_heap_used: 500,
                    proc_heap_total: 800,
                    event_loop_lag: 1,
                    sys_cpu_pct: index * 5,
                    sys_mem_used: 2000,
                    sys_mem_total: 8000,
                    disk_used: 100,
                    disk_total: 1000
                }),
                nodes: [
                    { node_id: 'n1', node_type: 'function', msg_count: index + 1, avg_process_ms: 1.5, error_count: 0, last_error_ts: null },
                    { node_id: 'n2', node_type: 'inject', msg_count: 1, avg_process_ms: 0.1, error_count: index % 3 === 0 ? 1 : 0, last_error_ts: index % 3 === 0 ? ts : null }
                ]
            });
        }
    });

    afterEach(function () {
        store.close();
        cleanupDbFiles(dbPath);
    });

    it('getRange raw returns rows within bounds', function () {
        const now = Date.now();
        const rows = store.getRange(now - 60_000 * 20, now);

        assert.strictEqual(rows.length, 10);
    });

    it('getRange with bucketMs groups via SQL', function () {
        const now = Date.now();
        const rows = store.getRange(now - 60_000 * 20, now, { bucketMs: 5000 });

        assert.ok(rows.length > 0 && rows.length < 10);
        assert.ok('proc_cpu_pct' in rows[0]);
    });

    it('getNodeStats returns only that node', function () {
        const now = Date.now();
        const rows = store.getNodeStats('n1', now - 60_000 * 20, now);

        assert.strictEqual(rows.length, 10);
        assert.ok(rows.every(function (row) {
            return row.node_id === 'n1';
        }));
    });

    it('getTopNodes ranks by msg_count', function () {
        const now = Date.now();
        const top = store.getTopNodes(now - 60_000 * 20, now, { metric: 'msg_count', n: 5 });

        assert.strictEqual(top[0].node_id, 'n1');
    });

    it('getSummary returns min/max/avg/p95 for proc_cpu_pct', function () {
        const now = Date.now();
        const summary = store.getSummary(60_000 * 20);

        assert.ok(summary.proc_cpu_pct);
        assert.strictEqual(summary.proc_cpu_pct.min, 0);
        assert.strictEqual(summary.proc_cpu_pct.max, 90);
        assert.ok(summary.proc_cpu_pct.avg >= 0);
        assert.ok(summary.proc_cpu_pct.p95 >= 0);
    });
});

describe('MetricsStore retention', function () {
    let store;
    let dbPath;

    beforeEach(function () {
        dbPath = tempDbPath();
        store = new MetricsStore({ dbPath: dbPath, retentionDays: 1 });
        store.open();
    });

    afterEach(function () {
        store.close();
        cleanupDbFiles(dbPath);
    });

    it('deletes samples older than retentionDays', function () {
        const now = Date.now();
        const oldTs = now - 1000 * 60 * 60 * 48;

        store.flush({ system: baseSystem(oldTs, { proc_cpu_pct: 1 }), nodes: [] });
        store.flush({ system: baseSystem(now, { proc_cpu_pct: 2 }), nodes: [] });

        assert.strictEqual(store._db.prepare('SELECT COUNT(*) AS count FROM samples').get().count, 2);

        const result = store.runRetention();

        assert.strictEqual(result.deletedSamples, 1);
        assert.strictEqual(store._db.prepare('SELECT COUNT(*) AS count FROM samples').get().count, 1);
    });

    it('emits retention event with counts', function () {
        const now = Date.now();
        const seen = [];

        store.flush({ system: baseSystem(now - 1000 * 60 * 60 * 48, { proc_cpu_pct: 1 }), nodes: [] });
        store.on('retention', function (payload) {
            seen.push(payload);
        });

        store.runRetention();

        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].deletedSamples, 1);
    });
});

describe('MetricsStore degraded mode', function () {
    it('falls back to in-memory when DB open throws and emits store:degraded', function () {
        const badPath = '/this/path/does/not/exist/at/all/pm.db';
        const store = new MetricsStore({ dbPath: badPath });
        const seen = [];
        const ts = Date.now();

        store.on('store:degraded', function (payload) {
            seen.push(payload);
        });

        store.openOrDegrade();
        store.flush({ system: baseSystem(ts, { proc_cpu_pct: 1 }), nodes: [] });

        assert.strictEqual(store.isDegraded(), true);
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(store.getRecent(10).length, 1);

        store.close();
    });
});

describe('MetricsStore events', function () {
    let store;
    let dbPath;

    beforeEach(function () {
        dbPath = tempDbPath();
        store = new MetricsStore({ dbPath: dbPath });
        store.open();
    });

    afterEach(function () {
        store.close();
        cleanupDbFiles(dbPath);
    });

    it('inserts events and reads them back', function () {
        const ts = Date.now();

        store.insertEvent({ ts: ts, kind: 'deploy', detail: { by: 'admin' } });

        const events = store.getEvents(ts - 1000, ts + 1000);

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].kind, 'deploy');
        assert.deepStrictEqual(JSON.parse(events[0].detail), { by: 'admin' });
    });
});
