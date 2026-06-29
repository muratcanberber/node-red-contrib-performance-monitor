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
        const row = store._db.prepare('PRAGMA journal_mode').get();
        assert.strictEqual(String(row.journal_mode).toLowerCase(), 'wal');
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

    it('setLoggingEnabled(false) skips DB writes but still emits sample', function () {
        store.setLoggingEnabled(false);
        const ts = Date.now();
        const sys = {
            ts, proc_cpu_pct: 10, proc_rss: 1000, proc_heap_used: 500, proc_heap_total: 800,
            event_loop_lag: 1, sys_cpu_pct: 20, sys_mem_used: 2000, sys_mem_total: 8000,
            disk_used: 100, disk_total: 1000, container: 0
        };
        let emitted = false;
        store.once('sample', () => { emitted = true; });
        store.flush({ system: sys, nodes: [] });
        assert.strictEqual(emitted, true, 'sample event must fire even when logging disabled');
        const rows = store.getRecent(10);
        assert.strictEqual(rows.length, 0, 'no DB row when logging disabled');
    });

    it('setLoggingEnabled(true) restores DB writes', function () {
        store.setLoggingEnabled(false);
        store.setLoggingEnabled(true);
        const ts = Date.now();
        store.flush({
            system: {
                ts, proc_cpu_pct: 5, proc_rss: 100, proc_heap_used: 50, proc_heap_total: 80,
                event_loop_lag: 0, sys_cpu_pct: 10, sys_mem_used: 1000, sys_mem_total: 4000,
                disk_used: 10, disk_total: 100, container: 0
            },
            nodes: []
        });
        assert.strictEqual(store.getRecent(10).length, 1);
    });

    describe('alarm rules CRUD', function () {
        it('getAlarmRules returns empty array initially', function () {
            const rules = store.getAlarmRules();
            assert.deepStrictEqual(rules, []);
        });

        it('insertAlarmRule creates and returns rule with id', function () {
            const rule = store.insertAlarmRule({
                metric: 'proc_cpu_pct',
                mode: 'fixed',
                threshold: 80,
                duration_s: 30,
                enabled: 1
            });
            assert.ok(rule.id > 0, 'id must be positive integer');
            assert.strictEqual(rule.metric, 'proc_cpu_pct');
            assert.strictEqual(rule.threshold, 80);
            assert.strictEqual(rule.enabled, 1);
        });

        it('getAlarmRules returns inserted rules', function () {
            store.insertAlarmRule({ metric: 'event_loop_lag', mode: 'fixed', threshold: 500, duration_s: 10, enabled: 1 });
            const rules = store.getAlarmRules();
            assert.ok(rules.length >= 1);
            assert.ok(rules.some(r => r.metric === 'event_loop_lag'));
        });

        it('updateAlarmRule modifies existing rule', function () {
            const rule = store.insertAlarmRule({ metric: 'proc_heap_used', mode: 'fixed', threshold: 500, duration_s: 60, enabled: 1 });
            const updated = store.updateAlarmRule(rule.id, { threshold: 600, enabled: 0 });
            assert.strictEqual(updated.threshold, 600);
            assert.strictEqual(updated.enabled, 0);
            assert.strictEqual(updated.metric, 'proc_heap_used'); // unchanged field
        });

        it('deleteAlarmRule removes rule', function () {
            const rule = store.insertAlarmRule({ metric: 'sys_cpu_pct', mode: 'statistical', threshold: 3, duration_s: 30, enabled: 1 });
            store.deleteAlarmRule(rule.id);
            const rules = store.getAlarmRules();
            assert.ok(!rules.some(r => r.id === rule.id));
        });
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

describe('MetricsStore degraded mode', function () {
    it('falls back to in-memory when DB open throws, emits "store:degraded"', function () {
        const badPath = '/this/path/does/not/exist/at/all/pm.db';
        const store = new MetricsStore({ dbPath: badPath });
        const seen = [];
        store.on('store:degraded', e => seen.push(e));
        store.openOrDegrade();
        assert.strictEqual(store.isDegraded(), true);
        assert.strictEqual(seen.length, 1);

        const ts = Date.now();
        store.flush({ system: { ts, proc_cpu_pct: 1, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0, event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0, disk_used: 0, disk_total: 0, container: 0 }, nodes: [] });
        assert.strictEqual(store.getRecent(10).length, 1);
        store.close();
    });
});

describe('MetricsStore events', function () {
    let store, dbPath;
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

    it('inserts events and reads them back', function () {
        const ts = Date.now();
        store.insertEvent({ ts, kind: 'deploy', detail: { by: 'admin' } });
        const events = store.getEvents(ts - 1000, ts + 1000);
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].kind, 'deploy');
        assert.deepStrictEqual(JSON.parse(events[0].detail), { by: 'admin' });
    });
});

describe('MetricsStore degraded reads never throw', function () {
    let store;
    beforeEach(function () {
        store = new MetricsStore({ dbPath: '/nope/does/not/exist/pm.db' });
        store.openOrDegrade();
    });
    afterEach(function () { store.close(); });

    it('is degraded', function () {
        assert.strictEqual(store.isDegraded(), true);
    });

    it('read methods return safe empties instead of throwing', function () {
        const now = Date.now();
        assert.deepStrictEqual(store.getRange(now - 1000, now), []);
        assert.deepStrictEqual(store.getRange(now - 1000, now, { bucketMs: 1000 }), []);
        assert.deepStrictEqual(store.getNodeStats('n1', now - 1000, now), []);
        assert.deepStrictEqual(store.getTopNodes(now - 1000, now, { metric: 'msg_count' }), []);
        assert.deepStrictEqual(store.getEvents(now - 1000, now), []);
        assert.deepStrictEqual(store.getSummary(1000), {});
        assert.deepStrictEqual(store.getAlarmRules(), []);
    });

    it('runRetention is a no-op in degraded mode', function () {
        const r = store.runRetention();
        assert.deepStrictEqual(r, { deletedSamples: 0, deletedNodeSamples: 0, deletedEvents: 0, cutoff: r.cutoff });
    });
});

function baseSystem(ts) {
    return {
        ts, proc_cpu_pct: 0, proc_rss: 0, proc_heap_used: 0, proc_heap_total: 0,
        event_loop_lag: 0, sys_cpu_pct: 0, sys_mem_used: 0, sys_mem_total: 0,
        disk_used: 0, disk_total: 0, container: 0
    };
}
