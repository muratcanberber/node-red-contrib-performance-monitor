const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const engine = require('../lib/storage/sqlite-engine');
const { runMigrations } = require('../lib/migrations');
const MetricsStore = require('../lib/metrics-store');

function tempDbPath() {
    return path.join(os.tmpdir(), `pm-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('legacy DB compatibility', function () {
    let dbPath;
    afterEach(function () {
        for (const suffix of ['', '-wal', '-shm']) {
            if (dbPath && fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
        }
    });

    it('opens a pre-existing migrated DB and reads prior rows', function () {
        dbPath = tempDbPath();
        // Simulate an older install: a fully-migrated DB with one sample row.
        const seed = engine.openDatabase(dbPath);
        runMigrations(seed);
        seed.prepare(`INSERT INTO samples
            (ts, proc_cpu_pct, proc_rss, proc_heap_used, proc_heap_total, event_loop_lag,
             sys_cpu_pct, sys_mem_used, sys_mem_total, disk_used, disk_total, container)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(1000, 5, 10, 20, 30, 0.5, 7, 100, 200, 1, 2, 0);
        seed.close();

        // New store opens the same file: migrations are idempotent, old row survives.
        const store = new MetricsStore({ dbPath });
        store.open();
        const recent = store.getRecent(10);
        assert.strictEqual(recent.length, 1);
        assert.strictEqual(recent[0].ts, 1000);
        assert.strictEqual(recent[0].proc_cpu_pct, 5);
        store.close();
    });
});
