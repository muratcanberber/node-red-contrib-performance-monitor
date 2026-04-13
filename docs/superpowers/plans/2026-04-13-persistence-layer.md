# Persistence Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SQLite-backed metrics persistence layer with live event stream to `node-red-contrib-performance-monitor`, extracted cleanly from the current monolithic plugin and ready to be consumed by later subsystems (flow node, anomaly detection, report view, sidebar UX refresh).

**Architecture:** Extract existing concerns (container detection, sampling, HTTP) into focused modules under `lib/`. Introduce `MetricsStore` (SQLite via `better-sqlite3`) and `MetricsCollector` (sampling + `RED.hooks` per-node instrumentation). Collector flushes every poll interval; store persists and emits a `sample` event. Graceful in-memory fallback if DB open fails.

**Tech Stack:** Node.js ≥14, Node-RED ≥1.1 (hooks API), `better-sqlite3` (prebuilt binaries), existing mocha + sinon for tests.

**Spec:** [../specs/2026-04-13-persistence-layer-design.md](../specs/2026-04-13-persistence-layer-design.md)

---

## File Structure

**New files:**
- `lib/container-detect.js` — extracted cgroup v1/v2 detection. Pure functions. One clear responsibility: tell us if we're containerized and what limits apply.
- `lib/metrics-store.js` — SQLite handle, schema management, read/write API, EventEmitter. No knowledge of Node-RED or HTTP.
- `lib/metrics-collector.js` — sampling functions + per-node aggregator via `RED.hooks`. Knows about Node-RED. No knowledge of SQL/DB.
- `lib/migrations/001-initial.js` — schema v1 migration. Exported as `{ version, up(db) }`.
- `lib/migrations/index.js` — migration runner, iterates ordered migrations.
- `lib/http-routes.js` — HTTP route registration + SSE stream endpoint. Consumes store interface only.
- `test/metrics-store.test.js` — store unit tests (schema, CRUD, retention, fallback).
- `test/metrics-collector.test.js` — collector unit tests (hooks, aggregation, drain).
- `test/container-detect.test.js` — cgroup detection tests (moved from monolith).
- `test/integration.test.js` — collector + store end-to-end with real SQLite.

**Modified files:**
- `performance-monitor.js` — slimmed to plugin entry. Wires collector → store → http-routes.
- `test/monitor_spec.js` — updated to exercise the slimmed entry via the new modules.
- `package.json` — `better-sqlite3` dep, `node-red.version >=1.1.0`, bump to `2.0.0`.
- `README.md` — drop "zero native dependencies" claim, add SQLite-backed history bullet.

Files that change together live together: each `lib/*.js` has a matching `test/*.test.js`. Boundaries mirror the design spec §Architecture.

---

## Task 1: Scaffold v2 Branch Work

**Files:**
- Modify: `package.json`
- Create: `lib/`, `lib/migrations/`

- [ ] **Step 1: Create directories**

Run:
```bash
mkdir -p lib/migrations
```

Expected: directories exist, `ls lib` shows `migrations`.

- [ ] **Step 2: Add better-sqlite3 dependency**

Run:
```bash
npm install --save better-sqlite3@^11.0.0
```

Expected: `package.json` gets `"dependencies": { "better-sqlite3": "^11.0.0" }`, `node_modules/better-sqlite3` installed from prebuilt binary (no compiler invocation).

- [ ] **Step 3: Verify install and require works**

Run:
```bash
node -e "const s = require('better-sqlite3'); const db = new s(':memory:'); db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES(1)'); console.log(db.prepare('SELECT x FROM t').get());"
```

Expected output: `{ x: 1 }`.

- [ ] **Step 4: Commit scaffold**

```bash
git add package.json package-lock.json lib
git commit -m "chore: scaffold lib/ and add better-sqlite3 dep"
```

---

## Task 2: Extract container-detect Module

Pure refactor. Move cgroup v1/v2 detection out of `performance-monitor.js` into `lib/container-detect.js`. Keep behavior identical. Add a focused test file.

**Files:**
- Create: `lib/container-detect.js`
- Create: `test/container-detect.test.js`
- Modify: `performance-monitor.js:14-170` (approx — the detection block)

- [ ] **Step 1: Write the failing test**

Create `test/container-detect.test.js`:

```js
const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const os = require('os');

describe('container-detect', function () {
    let sandbox;
    let detect;

    beforeEach(function () {
        sandbox = sinon.createSandbox();
        delete require.cache[require.resolve('../lib/container-detect.js')];
        detect = require('../lib/container-detect.js');
    });

    afterEach(function () {
        sandbox.restore();
    });

    it('returns non-containerized on non-linux', function () {
        sandbox.stub(os, 'platform').returns('darwin');
        const info = detect.detectContainerEnvironment({ force: true });
        assert.strictEqual(info.isContainerized, false);
        assert.strictEqual(info.cgroupVersion, null);
    });

    it('detects cgroup v2 memory limit below host total', function () {
        sandbox.stub(os, 'platform').returns('linux');
        sandbox.stub(os, 'totalmem').returns(16 * 1024 * 1024 * 1024);
        sandbox.stub(fs, 'existsSync').callsFake(p => p.includes('cgroup/memory.max'));
        sandbox.stub(fs, 'readFileSync').callsFake(p => {
            if (p.includes('memory.max')) return '2147483648\n';
            throw new Error('unexpected path ' + p);
        });

        const info = detect.detectContainerEnvironment({ force: true });
        assert.strictEqual(info.isContainerized, true);
        assert.strictEqual(info.cgroupVersion, 2);
        assert.strictEqual(info.memoryLimit, 2147483648);
    });

    it('ignores "max" value as no-limit in cgroup v2', function () {
        sandbox.stub(os, 'platform').returns('linux');
        sandbox.stub(fs, 'existsSync').callsFake(p => p.includes('cgroup/memory.max'));
        sandbox.stub(fs, 'readFileSync').returns('max\n');

        const info = detect.detectContainerEnvironment({ force: true });
        assert.strictEqual(info.isContainerized, false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/container-detect.test.js`
Expected: FAIL with `Cannot find module '../lib/container-detect.js'`.

- [ ] **Step 3: Create the module**

Create `lib/container-detect.js` by **moving** (not copying) the container-detection block from `performance-monitor.js`. Export shape:

```js
const os = require('os');
const fs = require('fs');

const CGROUP_V2_PATHS = {
    memoryMax: '/sys/fs/cgroup/memory.max',
    memoryCurrent: '/sys/fs/cgroup/memory.current',
    cpuMax: '/sys/fs/cgroup/cpu.max'
};

const CGROUP_V1_PATHS = {
    memoryLimit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    memoryUsage: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    cpuQuota: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
    cpuPeriod: '/sys/fs/cgroup/cpu/cpu.cfs_period_us'
};

let cached = null;

function detectContainerEnvironment({ force = false } = {}) {
    if (cached !== null && !force) return cached;

    const info = { isContainerized: false, cgroupVersion: null, memoryLimit: null, cpuLimit: null };

    if (os.platform() !== 'linux') {
        cached = info;
        return info;
    }

    try {
        if (fs.existsSync(CGROUP_V2_PATHS.memoryMax)) {
            const memMax = fs.readFileSync(CGROUP_V2_PATHS.memoryMax, 'utf8').trim();
            if (memMax !== 'max') {
                const memLimit = parseInt(memMax, 10);
                if (memLimit > 0 && memLimit < os.totalmem()) {
                    info.isContainerized = true;
                    info.cgroupVersion = 2;
                    info.memoryLimit = memLimit;
                }
            }
            if (fs.existsSync(CGROUP_V2_PATHS.cpuMax)) {
                const parts = fs.readFileSync(CGROUP_V2_PATHS.cpuMax, 'utf8').trim().split(' ');
                if (parts[0] !== 'max' && parts.length === 2) {
                    const quota = parseInt(parts[0], 10);
                    const period = parseInt(parts[1], 10);
                    if (quota > 0 && period > 0) {
                        info.cpuLimit = quota / period;
                        info.isContainerized = true;
                    }
                }
            }
        } else if (fs.existsSync(CGROUP_V1_PATHS.memoryLimit)) {
            const memLimit = parseInt(fs.readFileSync(CGROUP_V1_PATHS.memoryLimit, 'utf8').trim(), 10);
            const MAX_MEMORY_LIMIT = 9223372036854771712;
            if (memLimit > 0 && memLimit < MAX_MEMORY_LIMIT && memLimit < os.totalmem()) {
                info.isContainerized = true;
                info.cgroupVersion = 1;
                info.memoryLimit = memLimit;
            }
            if (fs.existsSync(CGROUP_V1_PATHS.cpuQuota) && fs.existsSync(CGROUP_V1_PATHS.cpuPeriod)) {
                const quota = parseInt(fs.readFileSync(CGROUP_V1_PATHS.cpuQuota, 'utf8').trim(), 10);
                const period = parseInt(fs.readFileSync(CGROUP_V1_PATHS.cpuPeriod, 'utf8').trim(), 10);
                if (quota > 0 && period > 0) {
                    info.cpuLimit = quota / period;
                    info.isContainerized = true;
                }
            }
        }
    } catch (_) {
        // Treat detection errors as "not containerized". Never crash on probe.
    }

    cached = info;
    return info;
}

function readContainerMemoryUsage() {
    try {
        if (fs.existsSync(CGROUP_V2_PATHS.memoryCurrent)) {
            return parseInt(fs.readFileSync(CGROUP_V2_PATHS.memoryCurrent, 'utf8').trim(), 10);
        }
        if (fs.existsSync(CGROUP_V1_PATHS.memoryUsage)) {
            return parseInt(fs.readFileSync(CGROUP_V1_PATHS.memoryUsage, 'utf8').trim(), 10);
        }
    } catch (_) {}
    return null;
}

module.exports = { detectContainerEnvironment, readContainerMemoryUsage, CGROUP_V1_PATHS, CGROUP_V2_PATHS };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx mocha test/container-detect.test.js`
Expected: 3 passing.

- [ ] **Step 5: Update the monolith to consume the extracted module**

In `performance-monitor.js`, delete the old cgroup constants/functions block and at the top add:

```js
const { detectContainerEnvironment, readContainerMemoryUsage } = require('./lib/container-detect');
```

Replace any internal callers of the old function names with the imported ones. Keep the rest of the plugin behavior unchanged.

- [ ] **Step 6: Run the full existing test suite**

Run: `npm test`
Expected: existing `monitor_spec.js` still passes + new `container-detect.test.js` passes. If a test in `monitor_spec.js` referenced the old internal container functions, update it to require from `lib/container-detect.js`.

- [ ] **Step 7: Commit**

```bash
git add lib/container-detect.js test/container-detect.test.js performance-monitor.js test/monitor_spec.js
git commit -m "refactor: extract container detection into lib/container-detect"
```

---

## Task 3: Migration Runner + Schema v1

Introduce a tiny, versioned migration runner and the initial schema. No collector or store yet — just the DB foundation.

**Files:**
- Create: `lib/migrations/001-initial.js`
- Create: `lib/migrations/index.js`
- Create: `test/migrations.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/migrations.test.js`:

```js
const assert = require('assert');
const Database = require('better-sqlite3');
const { runMigrations, CURRENT_VERSION } = require('../lib/migrations');

describe('migrations', function () {
    let db;

    beforeEach(function () { db = new Database(':memory:'); });
    afterEach(function () { db.close(); });

    it('creates schema and meta on fresh DB', function () {
        runMigrations(db);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
        assert.deepStrictEqual(tables, ['events', 'meta', 'node_samples', 'samples']);
        const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        assert.strictEqual(ver.value, String(CURRENT_VERSION));
    });

    it('is idempotent: running twice leaves schema unchanged', function () {
        runMigrations(db);
        runMigrations(db);
        const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        assert.strictEqual(ver.value, String(CURRENT_VERSION));
    });

    it('creates expected columns on samples', function () {
        runMigrations(db);
        const cols = db.prepare("PRAGMA table_info(samples)").all().map(c => c.name);
        assert.ok(cols.includes('ts'));
        assert.ok(cols.includes('proc_cpu_pct'));
        assert.ok(cols.includes('sys_cpu_pct'));
        assert.ok(cols.includes('container'));
    });

    it('creates expected columns on node_samples', function () {
        runMigrations(db);
        const cols = db.prepare("PRAGMA table_info(node_samples)").all().map(c => c.name);
        assert.ok(cols.includes('ts'));
        assert.ok(cols.includes('node_id'));
        assert.ok(cols.includes('msg_count'));
        assert.ok(cols.includes('avg_process_ms'));
        assert.ok(cols.includes('error_count'));
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/migrations.test.js`
Expected: FAIL `Cannot find module '../lib/migrations'`.

- [ ] **Step 3: Write 001-initial migration**

Create `lib/migrations/001-initial.js`:

```js
module.exports = {
    version: 1,
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS samples (
                ts              INTEGER PRIMARY KEY,
                proc_cpu_pct    REAL,
                proc_rss        INTEGER,
                proc_heap_used  INTEGER,
                proc_heap_total INTEGER,
                event_loop_lag  REAL,
                sys_cpu_pct     REAL,
                sys_mem_used    INTEGER,
                sys_mem_total   INTEGER,
                disk_used       INTEGER,
                disk_total      INTEGER,
                container       INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);

            CREATE TABLE IF NOT EXISTS node_samples (
                ts              INTEGER,
                node_id         TEXT,
                node_type       TEXT,
                msg_count       INTEGER,
                avg_process_ms  REAL,
                error_count     INTEGER,
                last_error_ts   INTEGER,
                PRIMARY KEY (ts, node_id)
            );
            CREATE INDEX IF NOT EXISTS idx_node_samples_node_ts ON node_samples(node_id, ts);

            CREATE TABLE IF NOT EXISTS events (
                ts     INTEGER PRIMARY KEY,
                kind   TEXT,
                detail TEXT
            );

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }
};
```

- [ ] **Step 4: Write the migration runner**

Create `lib/migrations/index.js`:

```js
const migrations = [
    require('./001-initial')
].sort((a, b) => a.version - b.version);

const CURRENT_VERSION = migrations[migrations.length - 1].version;

function getSchemaVersion(db) {
    const row = db.prepare(`
        SELECT value FROM meta WHERE key='schema_version'
    `).get();
    return row ? parseInt(row.value, 10) : 0;
}

function runMigrations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const current = getSchemaVersion(db);

    const tx = db.transaction(() => {
        for (const m of migrations) {
            if (m.version > current) {
                m.up(db);
            }
        }
        db.prepare(`
            INSERT INTO meta (key, value) VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(CURRENT_VERSION));
    });
    tx();
    return CURRENT_VERSION;
}

module.exports = { runMigrations, getSchemaVersion, CURRENT_VERSION };
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx mocha test/migrations.test.js`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add lib/migrations test/migrations.test.js
git commit -m "feat: add versioned migration runner and schema v1"
```

---

## Task 4: MetricsStore — open + flush samples

Introduce the store module with DB open (WAL, prepared statements), `flush()` for system + per-node, and a minimal `getRecent()` read.

**Files:**
- Create: `lib/metrics-store.js`
- Create: `test/metrics-store.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/metrics-store.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/metrics-store.test.js`
Expected: FAIL `Cannot find module '../lib/metrics-store'`.

- [ ] **Step 3: Write the store module**

Create `lib/metrics-store.js`:

```js
const EventEmitter = require('events');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

class MetricsStore extends EventEmitter {
    constructor({ dbPath, retentionDays = 7, maxDbSizeMB = 500 } = {}) {
        super();
        this.dbPath = dbPath;
        this.retentionDays = retentionDays;
        this.maxDbSizeMB = maxDbSizeMB;
        this._db = null;
        this._stmt = {};
        this._degraded = false;
        this._memoryBuffer = [];
    }

    open() {
        this._db = new Database(this.dbPath);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('synchronous = NORMAL');
        this._db.pragma('auto_vacuum = INCREMENTAL');
        runMigrations(this._db);
        this._prepare();
    }

    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }

    _prepare() {
        this._stmt.insertSample = this._db.prepare(`
            INSERT INTO samples
            (ts, proc_cpu_pct, proc_rss, proc_heap_used, proc_heap_total,
             event_loop_lag, sys_cpu_pct, sys_mem_used, sys_mem_total,
             disk_used, disk_total, container)
            VALUES
            (@ts, @proc_cpu_pct, @proc_rss, @proc_heap_used, @proc_heap_total,
             @event_loop_lag, @sys_cpu_pct, @sys_mem_used, @sys_mem_total,
             @disk_used, @disk_total, @container)
        `);
        this._stmt.insertNodeSample = this._db.prepare(`
            INSERT INTO node_samples
            (ts, node_id, node_type, msg_count, avg_process_ms, error_count, last_error_ts)
            VALUES
            (@ts, @node_id, @node_type, @msg_count, @avg_process_ms, @error_count, @last_error_ts)
        `);
        this._stmt.recentSamples = this._db.prepare(`
            SELECT * FROM samples ORDER BY ts DESC LIMIT ?
        `);
    }

    flush({ system, nodes = [] }) {
        if (!this._db) throw new Error('store not open');

        const tx = this._db.transaction(() => {
            this._stmt.insertSample.run(system);
            for (const n of nodes) {
                if (n.msg_count === 0 && n.error_count === 0) continue;
                this._stmt.insertNodeSample.run({ ts: system.ts, ...n });
            }
        });
        tx();
        this.emit('sample', { ts: system.ts, system, nodes });
    }

    getRecent(limit = 300) {
        return this._stmt.recentSamples.all(limit);
    }
}

module.exports = MetricsStore;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx mocha test/metrics-store.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-store.js test/metrics-store.test.js
git commit -m "feat: add MetricsStore with WAL-mode flush and recent read"
```

---

## Task 5: MetricsStore — read API (getRange, getNodeStats, getTopNodes, getEvents, getSummary)

Add the rest of the read API needed by later subsystems.

**Files:**
- Modify: `lib/metrics-store.js`
- Modify: `test/metrics-store.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/metrics-store.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/metrics-store.test.js`
Expected: 5 new failures, old tests still pass.

- [ ] **Step 3: Add read methods to the store**

In `lib/metrics-store.js`, extend `_prepare()` and add the methods:

```js
// inside _prepare()
this._stmt.rangeRaw = this._db.prepare(`
    SELECT * FROM samples WHERE ts BETWEEN ? AND ? ORDER BY ts ASC
`);
this._stmt.nodeStats = this._db.prepare(`
    SELECT * FROM node_samples
    WHERE node_id = ? AND ts BETWEEN ? AND ?
    ORDER BY ts ASC
`);
this._stmt.events = this._db.prepare(`
    SELECT * FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts ASC
`);
```

Add below `getRecent`:

```js
getRange(fromTs, toTs, { bucketMs = null } = {}) {
    if (!bucketMs) {
        return this._stmt.rangeRaw.all(fromTs, toTs);
    }
    return this._db.prepare(`
        SELECT
            (ts / ?) * ? AS ts,
            AVG(proc_cpu_pct)   AS proc_cpu_pct,
            MAX(proc_rss)       AS proc_rss,
            AVG(event_loop_lag) AS event_loop_lag,
            AVG(sys_cpu_pct)    AS sys_cpu_pct,
            AVG(sys_mem_used)   AS sys_mem_used
        FROM samples
        WHERE ts BETWEEN ? AND ?
        GROUP BY ts / ?
        ORDER BY ts ASC
    `).all(bucketMs, bucketMs, fromTs, toTs, bucketMs);
}

getNodeStats(nodeId, fromTs, toTs) {
    return this._stmt.nodeStats.all(nodeId, fromTs, toTs);
}

getTopNodes(fromTs, toTs, { metric = 'msg_count', n = 10 } = {}) {
    const allowed = new Set(['msg_count', 'avg_process_ms', 'error_count']);
    if (!allowed.has(metric)) throw new Error(`unknown metric: ${metric}`);
    const agg = metric === 'avg_process_ms' ? 'AVG' : 'SUM';
    return this._db.prepare(`
        SELECT node_id, node_type, ${agg}(${metric}) AS value
        FROM node_samples
        WHERE ts BETWEEN ? AND ?
        GROUP BY node_id
        ORDER BY value DESC
        LIMIT ?
    `).all(fromTs, toTs, n);
}

getEvents(fromTs, toTs, kinds = []) {
    if (kinds.length === 0) return this._stmt.events.all(fromTs, toTs);
    const placeholders = kinds.map(() => '?').join(',');
    return this._db.prepare(`
        SELECT * FROM events WHERE ts BETWEEN ? AND ? AND kind IN (${placeholders}) ORDER BY ts ASC
    `).all(fromTs, toTs, ...kinds);
}

getSummary(rangeMs) {
    const now = Date.now();
    const from = now - rangeMs;
    const cols = ['proc_cpu_pct', 'sys_cpu_pct', 'event_loop_lag'];
    const out = {};
    for (const c of cols) {
        const rowsStmt = this._db.prepare(`SELECT ${c} AS v FROM samples WHERE ts >= ? ORDER BY ${c} ASC`);
        const rows = rowsStmt.all(from);
        if (rows.length === 0) { out[c] = null; continue; }
        const min = rows[0].v, max = rows[rows.length - 1].v;
        const sum = rows.reduce((a, r) => a + r.v, 0);
        const avg = sum / rows.length;
        const p95Index = Math.min(rows.length - 1, Math.floor(rows.length * 0.95));
        out[c] = { min, max, avg, p95: rows[p95Index].v };
    }
    return out;
}
```

(Note: `getSummary` fetches per-column rows to compute p95; for the persistence milestone that's acceptable. If perf matters later, rewrite with a single windowed query.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx mocha test/metrics-store.test.js`
Expected: all passing (task 4 + task 5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-store.js test/metrics-store.test.js
git commit -m "feat: add getRange/getNodeStats/getTopNodes/getEvents/getSummary"
```

---

## Task 6: MetricsStore — retention + size-breach prune

Add `runRetention()` and size-cap fallback pruning.

**Files:**
- Modify: `lib/metrics-store.js`
- Modify: `test/metrics-store.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/metrics-store.test.js`:

```js
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
        const old = now - 1000 * 60 * 60 * 48; // 2 days old
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/metrics-store.test.js`
Expected: 2 new failures.

- [ ] **Step 3: Add retention methods**

In `lib/metrics-store.js`, add:

```js
runRetention() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    let deletedSamples = 0, deletedNodeSamples = 0, deletedEvents = 0;
    const tx = this._db.transaction(() => {
        deletedSamples      = this._db.prepare('DELETE FROM samples      WHERE ts < ?').run(cutoff).changes;
        deletedNodeSamples  = this._db.prepare('DELETE FROM node_samples WHERE ts < ?').run(cutoff).changes;
        deletedEvents       = this._db.prepare('DELETE FROM events       WHERE ts < ?').run(cutoff).changes;
    });
    tx();
    try { this._db.pragma('incremental_vacuum'); } catch (_) {}
    const result = { deletedSamples, deletedNodeSamples, deletedEvents, cutoff };
    this.emit('retention', result);
    return result;
}

pruneOldestFraction(fraction = 0.1) {
    const total = this._db.prepare('SELECT COUNT(*) c FROM samples').get().c;
    const limit = Math.max(1, Math.floor(total * fraction));
    const cutRow = this._db.prepare('SELECT ts FROM samples ORDER BY ts ASC LIMIT 1 OFFSET ?').get(limit);
    if (!cutRow) return { deletedSamples: 0 };
    const tx = this._db.transaction(() => {
        this._db.prepare('DELETE FROM samples      WHERE ts <= ?').run(cutRow.ts);
        this._db.prepare('DELETE FROM node_samples WHERE ts <= ?').run(cutRow.ts);
        this._db.prepare('DELETE FROM events       WHERE ts <= ?').run(cutRow.ts);
    });
    tx();
    return { deletedSamples: limit };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx mocha test/metrics-store.test.js`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-store.js test/metrics-store.test.js
git commit -m "feat: add retention + size-breach prune to MetricsStore"
```

---

## Task 7: MetricsStore — degraded fallback + events insert

DB open failure must not crash. Fall back to in-memory ring buffer. Also add `insertEvent` for deploy markers.

**Files:**
- Modify: `lib/metrics-store.js`
- Modify: `test/metrics-store.test.js`

- [ ] **Step 1: Write failing tests**

Append:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/metrics-store.test.js`
Expected: 2 new failures.

- [ ] **Step 3: Add degraded mode + insertEvent**

In `lib/metrics-store.js`:

```js
openOrDegrade() {
    try {
        this.open();
    } catch (err) {
        this._degraded = true;
        this._memoryBuffer = [];
        this.emit('store:degraded', { error: err.message });
    }
}

isDegraded() { return this._degraded; }

insertEvent({ ts, kind, detail }) {
    if (!this._db) throw new Error('store not open');
    this._db.prepare(`INSERT OR REPLACE INTO events (ts, kind, detail) VALUES (?, ?, ?)`)
        .run(ts, kind, detail == null ? null : JSON.stringify(detail));
    this.emit('event', { ts, kind, detail });
}
```

And adjust `flush`/`getRecent` to handle the degraded path (in-memory buffer bounded to 300):

```js
flush({ system, nodes = [] }) {
    if (this._degraded) {
        this._memoryBuffer.push({ ts: system.ts, system, nodes });
        while (this._memoryBuffer.length > 300) this._memoryBuffer.shift();
        this.emit('sample', { ts: system.ts, system, nodes });
        return;
    }
    if (!this._db) throw new Error('store not open');
    const tx = this._db.transaction(() => {
        this._stmt.insertSample.run(system);
        for (const n of nodes) {
            if (n.msg_count === 0 && n.error_count === 0) continue;
            this._stmt.insertNodeSample.run({ ts: system.ts, ...n });
        }
    });
    tx();
    this.emit('sample', { ts: system.ts, system, nodes });
}

getRecent(limit = 300) {
    if (this._degraded) {
        return this._memoryBuffer.slice(-limit).map(e => e.system).reverse();
    }
    return this._stmt.recentSamples.all(limit);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx mocha test/metrics-store.test.js`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-store.js test/metrics-store.test.js
git commit -m "feat: add degraded in-memory fallback and insertEvent"
```

---

## Task 8: MetricsCollector — pure sampling functions (extract from monolith)

Move existing `getCpuUsage` / `getMemory` / `getEventLoopLag` / `getSystemStats` / `getDisk` functions out of `performance-monitor.js` into `lib/metrics-collector.js` as pure functions that return a snapshot object.

**Files:**
- Create: `lib/metrics-collector.js`
- Create: `test/metrics-collector.test.js`
- Modify: `performance-monitor.js`

- [ ] **Step 1: Inventory sampling functions in the monolith**

Run:
```bash
grep -n "^function \|^const .* = function\|^    function " performance-monitor.js | head -40
```

Expected: list of all internal functions. Note the exact names — they become pure exports.

- [ ] **Step 2: Write failing test for sampling snapshot shape**

Create `test/metrics-collector.test.js`:

```js
const assert = require('assert');
const MetricsCollector = require('../lib/metrics-collector');

function makeRED() {
    return {
        log: { info() {}, warn() {}, error() {} },
        hooks: { add() {} },
        events: { on() {} }
    };
}

describe('MetricsCollector.sampleSystem', function () {
    it('returns snapshot object with all expected keys', function () {
        const c = new MetricsCollector({ RED: makeRED() });
        const s = c.sampleSystem();
        const keys = ['ts', 'proc_cpu_pct', 'proc_rss', 'proc_heap_used', 'proc_heap_total',
            'event_loop_lag', 'sys_cpu_pct', 'sys_mem_used', 'sys_mem_total',
            'disk_used', 'disk_total', 'container'];
        for (const k of keys) assert.ok(k in s, `missing key: ${k}`);
        assert.ok(typeof s.ts === 'number' && s.ts > 0);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx mocha test/metrics-collector.test.js`
Expected: FAIL `Cannot find module '../lib/metrics-collector'`.

- [ ] **Step 4: Create MetricsCollector with sampleSystem()**

Create `lib/metrics-collector.js`. Copy the existing sampling logic from `performance-monitor.js` but reshape into the snapshot object keyed as in the spec:

```js
const os = require('os');
const fs = require('fs');
const path = require('path');
const { detectContainerEnvironment, readContainerMemoryUsage } = require('./container-detect');

class MetricsCollector {
    constructor({ RED, pollInterval = 2000 } = {}) {
        this.RED = RED;
        this.pollInterval = pollInterval;
        this._lastCpu = process.cpuUsage();
        this._lastCpuTs = process.hrtime.bigint();
        this._lastLoopCheck = process.hrtime.bigint();
        this._loopLag = 0;
        this._nodes = new Map();        // node_id -> { type, count, sumMs, errors, lastErrorTs, starts: Map<msgId, hrtime> }
        this._container = detectContainerEnvironment();

        this._startLoopLagProbe();
    }

    _startLoopLagProbe() {
        const intervalMs = 500;
        this._loopTimer = setInterval(() => {
            const now = process.hrtime.bigint();
            const diffMs = Number(now - this._lastLoopCheck) / 1e6;
            this._loopLag = Math.max(0, diffMs - intervalMs);
            this._lastLoopCheck = now;
        }, intervalMs);
        if (this._loopTimer.unref) this._loopTimer.unref();
    }

    sampleSystem() {
        const ts = Date.now();

        // Process CPU%
        const cpu = process.cpuUsage();
        const now = process.hrtime.bigint();
        const elapsedMicros = Number(now - this._lastCpuTs) / 1000;
        const userDelta = cpu.user - this._lastCpu.user;
        const sysDelta = cpu.system - this._lastCpu.system;
        const procCpuPct = elapsedMicros > 0
            ? ((userDelta + sysDelta) / elapsedMicros) * 100
            : 0;
        this._lastCpu = cpu;
        this._lastCpuTs = now;

        const mem = process.memoryUsage();

        // System CPU%
        const cpus = os.cpus();
        let sysUser = 0, sysSys = 0, sysIdle = 0, sysTotal = 0;
        for (const c of cpus) {
            sysUser  += c.times.user;
            sysSys   += c.times.sys;
            sysIdle  += c.times.idle;
            sysTotal += c.times.user + c.times.sys + c.times.idle + c.times.nice + c.times.irq;
        }
        const sysCpuPct = sysTotal > 0 ? ((sysTotal - sysIdle) / sysTotal) * 100 : 0;

        const sysMemTotal = this._container.memoryLimit || os.totalmem();
        let sysMemUsed;
        if (this._container.isContainerized) {
            const cg = readContainerMemoryUsage();
            sysMemUsed = (cg != null) ? cg : (os.totalmem() - os.freemem());
        } else {
            sysMemUsed = os.totalmem() - os.freemem();
        }

        // Disk: sync statfs of node-red userDir (fallback to cwd)
        let diskUsed = 0, diskTotal = 0;
        try {
            const stat = fs.statfsSync ? fs.statfsSync(process.cwd()) : null;
            if (stat) {
                diskTotal = stat.blocks * stat.bsize;
                diskUsed = (stat.blocks - stat.bfree) * stat.bsize;
            }
        } catch (_) {}

        return {
            ts,
            proc_cpu_pct: procCpuPct,
            proc_rss: mem.rss,
            proc_heap_used: mem.heapUsed,
            proc_heap_total: mem.heapTotal,
            event_loop_lag: this._loopLag,
            sys_cpu_pct: sysCpuPct,
            sys_mem_used: sysMemUsed,
            sys_mem_total: sysMemTotal,
            disk_used: diskUsed,
            disk_total: diskTotal,
            container: this._container.isContainerized ? 1 : 0
        };
    }

    stop() {
        clearInterval(this._loopTimer);
    }
}

module.exports = MetricsCollector;
```

- [ ] **Step 5: Run tests**

Run: `npx mocha test/metrics-collector.test.js`
Expected: 1 passing.

- [ ] **Step 6: Commit**

```bash
git add lib/metrics-collector.js test/metrics-collector.test.js
git commit -m "feat: add MetricsCollector.sampleSystem (extracted pure functions)"
```

---

## Task 9: MetricsCollector — per-node hooks + aggregator

Install `RED.hooks` for `preRoute` / `postRoute` / node error. Accumulate per-node stats. Expose `drainNodes()` that returns the current stats and resets counters.

**Files:**
- Modify: `lib/metrics-collector.js`
- Modify: `test/metrics-collector.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/metrics-collector.test.js`:

```js
describe('MetricsCollector per-node hooks', function () {
    let RED;
    let hooks;
    let collector;

    beforeEach(function () {
        hooks = {};
        RED = {
            log: { info() {}, warn() {}, error() {} },
            hooks: { add: (name, fn) => { hooks[name] = fn; } },
            events: { on() {} }
        };
        collector = new MetricsCollector({ RED });
        collector.attachHooks();
    });

    it('registers preRoute and postRoute hooks', function () {
        assert.ok(typeof hooks.preRoute === 'function');
        assert.ok(typeof hooks.postRoute === 'function');
    });

    it('aggregates msg count and avg process time per node', function () {
        const msg = { _msgid: 'm1' };
        const sendEvents = { source: { node: { id: 'n1', type: 'function' } }, msg };
        hooks.preRoute(sendEvents);
        const start = Date.now();
        // simulate some work
        while (Date.now() - start < 2) {}
        hooks.postRoute(sendEvents);

        const snap = collector.drainNodes();
        assert.strictEqual(snap.length, 1);
        assert.strictEqual(snap[0].node_id, 'n1');
        assert.strictEqual(snap[0].msg_count, 1);
        assert.ok(snap[0].avg_process_ms >= 0);
    });

    it('drainNodes resets counters', function () {
        const sendEvents = { source: { node: { id: 'n2', type: 'inject' } }, msg: { _msgid: 'x' } };
        hooks.preRoute(sendEvents);
        hooks.postRoute(sendEvents);
        collector.drainNodes();
        const snap2 = collector.drainNodes();
        assert.strictEqual(snap2.length, 0);
    });

    it('one hook throw does not crash tick', function () {
        assert.doesNotThrow(() => hooks.postRoute({ source: null, msg: null }));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha test/metrics-collector.test.js`
Expected: FAILs (`attachHooks`, `drainNodes` not defined).

- [ ] **Step 3: Add attachHooks + drainNodes**

Extend `lib/metrics-collector.js`:

```js
attachHooks() {
    if (!this.RED || !this.RED.hooks) return;

    this.RED.hooks.add('preRoute', (sendEvents) => {
        try {
            const node = sendEvents && sendEvents.source && sendEvents.source.node;
            const msg = sendEvents && sendEvents.msg;
            if (!node || !msg) return;
            const rec = this._ensureNodeRec(node.id, node.type);
            rec.starts.set(msg._msgid, process.hrtime.bigint());
        } catch (_) {}
    });

    this.RED.hooks.add('postRoute', (sendEvents) => {
        try {
            const node = sendEvents && sendEvents.source && sendEvents.source.node;
            const msg = sendEvents && sendEvents.msg;
            if (!node || !msg) return;
            const rec = this._ensureNodeRec(node.id, node.type);
            const start = rec.starts.get(msg._msgid);
            if (start !== undefined) {
                const deltaMs = Number(process.hrtime.bigint() - start) / 1e6;
                rec.count += 1;
                rec.sumMs += deltaMs;
                rec.starts.delete(msg._msgid);
            }
        } catch (_) {}
    });
}

_ensureNodeRec(id, type) {
    let rec = this._nodes.get(id);
    if (!rec) {
        rec = { type, count: 0, sumMs: 0, errors: 0, lastErrorTs: null, starts: new Map() };
        this._nodes.set(id, rec);
    } else {
        rec.type = type || rec.type;
    }
    return rec;
}

recordNodeError(nodeId, nodeType) {
    const rec = this._ensureNodeRec(nodeId, nodeType);
    rec.errors += 1;
    rec.lastErrorTs = Date.now();
}

drainNodes() {
    const out = [];
    for (const [id, rec] of this._nodes.entries()) {
        out.push({
            node_id: id,
            node_type: rec.type,
            msg_count: rec.count,
            avg_process_ms: rec.count > 0 ? rec.sumMs / rec.count : 0,
            error_count: rec.errors,
            last_error_ts: rec.lastErrorTs
        });
        rec.count = 0;
        rec.sumMs = 0;
        rec.errors = 0;
        rec.lastErrorTs = null;
        if (rec.starts.size > 1000) rec.starts.clear();
    }
    return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx mocha test/metrics-collector.test.js`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-collector.js test/metrics-collector.test.js
git commit -m "feat: add per-node hooks + aggregator + drainNodes"
```

---

## Task 10: MetricsCollector — deploy/error event capture

Subscribe to `RED.events.on('flows:started' | 'flows:stopped')` and `RED.log` via a thin shim, route markers to the store.

**Files:**
- Modify: `lib/metrics-collector.js`
- Modify: `test/metrics-collector.test.js`

- [ ] **Step 1: Write failing test**

Append:

```js
describe('MetricsCollector lifecycle events', function () {
    it('emits deploy event on flows:started', function (done) {
        const handlers = {};
        const RED = {
            log: { info() {}, warn() {}, error() {} },
            hooks: { add() {} },
            events: { on: (name, fn) => { handlers[name] = fn; } }
        };
        const collector = new MetricsCollector({ RED });
        collector.on('event', e => {
            assert.strictEqual(e.kind, 'deploy');
            done();
        });
        collector.attachLifecycleListeners();
        handlers['flows:started']({ config: {} });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/metrics-collector.test.js`
Expected: FAIL — `attachLifecycleListeners` not defined.

- [ ] **Step 3: Make collector an EventEmitter + attachLifecycleListeners**

In `lib/metrics-collector.js`, change class to extend `EventEmitter`:

```js
const EventEmitter = require('events');
// ...
class MetricsCollector extends EventEmitter {
    constructor(opts = {}) {
        super();
        // ... existing body
    }

    attachLifecycleListeners() {
        if (!this.RED || !this.RED.events) return;
        this.RED.events.on('flows:started', () => {
            this.emit('event', { ts: Date.now(), kind: 'deploy', detail: null });
        });
        this.RED.events.on('flows:stopped', () => {
            this.emit('event', { ts: Date.now(), kind: 'stop', detail: null });
        });
    }
}
```

- [ ] **Step 4: Run tests**

Run: `npx mocha test/metrics-collector.test.js`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-collector.js test/metrics-collector.test.js
git commit -m "feat: emit deploy/stop lifecycle events from collector"
```

---

## Task 11: Flush loop + integration test

Add a `start(store)` method that drives the flush cycle and wires events. Then an end-to-end test using real SQLite.

**Files:**
- Modify: `lib/metrics-collector.js`
- Create: `test/integration.test.js`

- [ ] **Step 1: Add start/stop driving the flush cycle**

In `lib/metrics-collector.js`:

```js
start(store) {
    this._store = store;
    this.attachHooks();
    this.attachLifecycleListeners();
    this.on('event', e => { try { store.insertEvent(e); } catch (_) {} });

    this._flushTimer = setInterval(() => this.tick(), this.pollInterval);
    if (this._flushTimer.unref) this._flushTimer.unref();
}

tick() {
    const tStart = Date.now();
    const system = this.sampleSystem();
    const nodes = this.drainNodes();
    try {
        this._store.flush({ system, nodes });
    } catch (err) {
        if (this.RED && this.RED.log) this.RED.log.warn(`[perf-monitor] flush failed: ${err.message}`);
    }
    const elapsed = Date.now() - tStart;
    if (elapsed > 500 && this.RED && this.RED.log) {
        this.RED.log.warn(`[perf-monitor] slow flush: ${elapsed}ms`);
    }
}

stop() {
    clearInterval(this._loopTimer);
    clearInterval(this._flushTimer);
}
```

- [ ] **Step 2: Write integration test**

Create `test/integration.test.js`:

```js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const MetricsStore = require('../lib/metrics-store');
const MetricsCollector = require('../lib/metrics-collector');

function tempDbPath() {
    return path.join(os.tmpdir(), `pm-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('collector + store integration', function () {
    this.timeout(5000);

    it('flushes a real sample through to SQLite and emits sample event', function (done) {
        const dbPath = tempDbPath();
        const store = new MetricsStore({ dbPath });
        store.open();

        const hooks = {};
        const RED = {
            log: { info() {}, warn() {}, error() {} },
            hooks: { add: (n, fn) => { hooks[n] = fn; } },
            events: { on() {} }
        };
        const collector = new MetricsCollector({ RED, pollInterval: 100 });
        collector.start(store);

        store.once('sample', (payload) => {
            try {
                assert.ok(payload.system.ts > 0);
                const recent = store.getRecent(10);
                assert.ok(recent.length >= 1);

                collector.stop();
                store.close();
                for (const suffix of ['', '-wal', '-shm']) {
                    const p = dbPath + suffix;
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                }
                done();
            } catch (e) { done(e); }
        });
    });
});
```

- [ ] **Step 3: Run integration test**

Run: `npx mocha test/integration.test.js`
Expected: 1 passing.

- [ ] **Step 4: Commit**

```bash
git add lib/metrics-collector.js test/integration.test.js
git commit -m "feat: add flush loop and integration coverage"
```

---

## Task 12: HTTP routes + SSE stream

Extract existing HTTP routes to `lib/http-routes.js`. Add SSE endpoint that forwards `store.on('sample')`.

**Files:**
- Create: `lib/http-routes.js`
- Modify: `performance-monitor.js`

- [ ] **Step 1: Inventory existing HTTP routes**

Run:
```bash
grep -n "RED.httpAdmin\." performance-monitor.js
```

Expected: list of current routes. Note paths + handlers.

- [ ] **Step 2: Create http-routes module**

Create `lib/http-routes.js`:

```js
function registerRoutes({ RED, store, collector }) {
    // GET /performance-monitor/recent  → last N raw samples
    RED.httpAdmin.get('/performance-monitor/recent', (req, res) => {
        const limit = Math.min(1000, parseInt(req.query.limit, 10) || 300);
        res.json({ samples: store.getRecent(limit) });
    });

    // GET /performance-monitor/range?from=..&to=..&bucket=..
    RED.httpAdmin.get('/performance-monitor/range', (req, res) => {
        const from = parseInt(req.query.from, 10);
        const to = parseInt(req.query.to, 10);
        const bucket = req.query.bucket ? parseInt(req.query.bucket, 10) : null;
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
            return res.status(400).json({ error: 'from and to required' });
        }
        res.json({ rows: store.getRange(from, to, { bucketMs: bucket }) });
    });

    // GET /performance-monitor/summary?range=..
    RED.httpAdmin.get('/performance-monitor/summary', (req, res) => {
        const range = parseInt(req.query.range, 10) || 60_000 * 5;
        res.json({ summary: store.getSummary(range) });
    });

    // GET /performance-monitor/stream  (SSE live)
    RED.httpAdmin.get('/performance-monitor/stream', (req, res) => {
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.flushHeaders();

        const onSample = (payload) => {
            res.write(`event: sample\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        const onEvent = (payload) => {
            res.write(`event: event\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        store.on('sample', onSample);
        store.on('event', onEvent);

        req.on('close', () => {
            store.off('sample', onSample);
            store.off('event', onEvent);
        });
    });
}

module.exports = { registerRoutes };
```

- [ ] **Step 3: Add a small route test**

Create `test/http-routes.test.js`:

```js
const assert = require('assert');
const { registerRoutes } = require('../lib/http-routes');
const EventEmitter = require('events');

describe('http-routes', function () {
    it('registers /performance-monitor/recent on RED.httpAdmin', function () {
        const routes = {};
        const RED = { httpAdmin: { get: (path, fn) => { routes[path] = fn; } } };
        const store = { getRecent: () => [] };
        registerRoutes({ RED, store });
        assert.ok('/performance-monitor/recent' in routes);
        assert.ok('/performance-monitor/stream' in routes);
    });

    it('/recent handler responds with samples', function () {
        const routes = {};
        const RED = { httpAdmin: { get: (path, fn) => { routes[path] = fn; } } };
        const store = { getRecent: (n) => [{ ts: 1, proc_cpu_pct: 5 }] };
        registerRoutes({ RED, store });

        let body;
        routes['/performance-monitor/recent'](
            { query: {} },
            { json: (b) => { body = b; } }
        );
        assert.deepStrictEqual(body, { samples: [{ ts: 1, proc_cpu_pct: 5 }] });
    });
});
```

- [ ] **Step 4: Run tests**

Run: `npx mocha test/http-routes.test.js`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/http-routes.js test/http-routes.test.js
git commit -m "feat: extract HTTP routes and add SSE stream endpoint"
```

---

## Task 13: Rewire plugin entry

Slim `performance-monitor.js` to orchestrate: construct store, construct collector, register routes, wire shutdown. Remove extracted code. Keep plugin registration + settings load.

**Files:**
- Modify: `performance-monitor.js`
- Modify: `test/monitor_spec.js` (update expectations)

- [ ] **Step 1: Rewrite plugin entry**

Replace the body of `performance-monitor.js` with orchestration only:

```js
const path = require('path');
const MetricsStore = require('./lib/metrics-store');
const MetricsCollector = require('./lib/metrics-collector');
const { registerRoutes } = require('./lib/http-routes');

module.exports = function (RED) {
    const settings = (RED.settings && RED.settings.performanceMonitor) || {};
    const pollInterval = settings.pollInterval || 2000;
    const retentionDays = settings.retentionDays || 7;
    const maxDbSizeMB = settings.maxDbSizeMB || 500;

    const userDir = (RED.settings && RED.settings.userDir) || process.cwd();
    const dbPath = path.join(userDir, 'performance-monitor.db');

    const store = new MetricsStore({ dbPath, retentionDays, maxDbSizeMB });
    store.openOrDegrade();
    if (store.isDegraded()) {
        RED.log.warn('[perf-monitor] DB unavailable — running in in-memory mode');
    }

    const collector = new MetricsCollector({ RED, pollInterval });
    collector.start(store);

    registerRoutes({ RED, store, collector });

    // Retention sweep every hour
    const retentionTimer = setInterval(() => {
        try { store.runRetention(); } catch (_) {}
    }, 60 * 60 * 1000);
    if (retentionTimer.unref) retentionTimer.unref();

    RED.plugins.registerPlugin('performance-monitor', {
        type: 'performance-monitor',
        onadd() { RED.log.info('[perf-monitor] plugin loaded'); }
    });

    // Shutdown hook
    if (RED.events && RED.events.on) {
        RED.events.on('runtime-event', (ev) => {
            if (ev && ev.id === 'shutdown') {
                clearInterval(retentionTimer);
                collector.stop();
                store.close();
            }
        });
    }

    // Expose internals for tests (same contract the old module had)
    module.exports._internal = { store, collector };
};
```

- [ ] **Step 2: Update existing monitor_spec.js to match new shape**

Open `test/monitor_spec.js`. The old tests probably exercised internal sampling functions directly. Replace assertions that touched `_internal.getCpuUsage` etc with calls through the new modules:

```js
// OLD: monitorModule._internal.getCpuUsage(...)
// NEW: instantiate MetricsCollector and call sampleSystem(), OR remove the test if it's covered elsewhere.
```

Minimum viable refactor: keep tests that verify the plugin registers with `RED.plugins.registerPlugin`. Delete tests that probe now-extracted internals (they're covered in the focused test files).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass (store, collector, migrations, container-detect, http-routes, integration, monitor_spec).

- [ ] **Step 4: Commit**

```bash
git add performance-monitor.js test/monitor_spec.js
git commit -m "refactor: slim plugin entry to orchestration only"
```

---

## Task 14: Settings UI — retention + DB size controls

Expose `retentionDays` and `maxDbSizeMB` in the sidebar settings panel. Minimal change — the UI work is in a later spec, this only surfaces the knobs.

**Files:**
- Modify: `performance-monitor.html` (settings section)

- [ ] **Step 1: Locate settings UI markup**

Run:
```bash
grep -n "settings\|refreshRate\|pollInterval" performance-monitor.html | head -20
```

Note the section where existing settings (refresh rate, theme) are rendered.

- [ ] **Step 2: Add form fields**

In `performance-monitor.html`, inside the settings panel markup, add two rows next to the refresh-rate control:

```html
<div class="pm-setting-row">
  <label for="pm-retention-days">History retention (days)</label>
  <input type="number" id="pm-retention-days" min="1" max="90" value="7">
</div>
<div class="pm-setting-row">
  <label for="pm-max-db-mb">Max DB size (MB)</label>
  <input type="number" id="pm-max-db-mb" min="50" max="10000" value="500">
</div>
```

In the settings save handler (JS block in the HTML), POST the values to a new admin endpoint. Add to `lib/http-routes.js`:

```js
RED.httpAdmin.post('/performance-monitor/settings', (req, res) => {
    const { retentionDays, maxDbSizeMB } = req.body || {};
    if (Number.isFinite(retentionDays)) store.retentionDays = retentionDays;
    if (Number.isFinite(maxDbSizeMB)) store.maxDbSizeMB = maxDbSizeMB;
    res.json({ ok: true, retentionDays: store.retentionDays, maxDbSizeMB: store.maxDbSizeMB });
});

RED.httpAdmin.get('/performance-monitor/settings', (req, res) => {
    res.json({ retentionDays: store.retentionDays, maxDbSizeMB: store.maxDbSizeMB });
});
```

Add a test for the new routes:

```js
it('POST /settings updates retentionDays on store', function () {
    const routes = {};
    const RED = { httpAdmin: {
        get: (p, fn) => { routes['GET ' + p] = fn; },
        post: (p, fn) => { routes['POST ' + p] = fn; }
    }};
    const store = { retentionDays: 7, maxDbSizeMB: 500, getRecent: () => [] };
    registerRoutes({ RED, store });

    let body;
    routes['POST /performance-monitor/settings'](
        { body: { retentionDays: 30 } },
        { json: (b) => { body = b; } }
    );
    assert.strictEqual(body.retentionDays, 30);
    assert.strictEqual(store.retentionDays, 30);
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all passing.

- [ ] **Step 4: Commit**

```bash
git add performance-monitor.html lib/http-routes.js test/http-routes.test.js
git commit -m "feat: surface retentionDays + maxDbSizeMB in settings UI"
```

---

## Task 15: Docs + version bump

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump package + node-red version**

In `package.json`:

```json
{
  "version": "2.0.0",
  "node-red": {
    "version": ">=1.1.0",
    "plugins": { "performance-monitor": "performance-monitor.js" }
  }
}
```

Run:
```bash
npm install
```

Expected: `package-lock.json` refreshes, no errors.

- [ ] **Step 2: Update README**

In `README.md`:
- Remove the "🚀 Zero Dependencies (No binary compilation required)" bullet.
- Add under Features: `- **Historical metrics**: SQLite-backed history with configurable retention (default 7 days).`
- Add a Configuration row for `History retention` and `Max DB size`.

- [ ] **Step 3: Update CHANGELOG**

Prepend to `CHANGELOG.md`:

```markdown
## 2.0.0 — 2026-04-13

### Added
- SQLite-backed metrics persistence (`performance-monitor.db` in Node-RED user dir).
- Per-node instrumentation via `RED.hooks` (msg count, avg process time, errors).
- Live SSE stream at `GET /performance-monitor/stream`.
- Historical query endpoints (`/recent`, `/range`, `/summary`).
- Retention + max-DB-size controls in settings UI.
- Deploy/stop lifecycle markers recorded for future anomaly analysis.

### Changed
- **BREAKING**: now requires Node-RED ≥ 1.1.0 (hooks API).
- **BREAKING**: drops "zero native dependencies" claim — adds `better-sqlite3` (ships prebuilt binaries).
- Code reorganized into `lib/` modules (internal change).

### Migration
- First launch post-upgrade creates a fresh `performance-monitor.db`. No user action required.
```

- [ ] **Step 4: Final test run**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json README.md CHANGELOG.md
git commit -m "chore: bump to 2.0.0, update docs for persistence layer"
```

---

## Post-Plan Verification

Run through the acceptance criteria from the spec:

- [ ] Fresh install creates `<userDir>/performance-monitor.db` with schema v1 — manual check by starting Node-RED with the plugin and inspecting the file.
- [ ] Flush < 50ms typical on a 10-node flow at 100 msg/s — measure with an integration benchmark script (optional, not in CI).
- [ ] Sidebar receives live events via SSE within 2 × pollInterval — manual browser check at `/performance-monitor/stream`.
- [ ] DB open failure enters degraded mode — manual check by making userDir read-only and starting Node-RED.
- [ ] `npm test` green on GitHub Actions — CI run on the PR.

---

## Notes for the Next Spec (Flow Node)

The persistence layer now provides:
- `store.on('sample', ...)` — real-time stream the flow node will subscribe to.
- `store.getNodeStats(nodeId, ...)` — per-node history lookup.
- `store.getSummary(rangeMs)` — quick rollup for node status badge.

When the flow-node spec is written, it should depend on this API surface and nothing internal to the collector or HTTP layer.
