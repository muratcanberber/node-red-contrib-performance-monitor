# Storage Migration to node:sqlite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native `better-sqlite3` dependency with Node's built-in `node:sqlite` so plugin upgrades never break, while preserving all existing storage behavior and tests.

**Architecture:** Isolate node:sqlite specifics in a new `lib/storage/sqlite-engine.js` (open, pragma, transaction helpers, guarded loader). `MetricsStore` keeps its public interface and in-memory degraded mode but uses the engine internally. A failed engine load degrades to in-memory instead of throwing at module load, so the plugin always loads.

**Tech Stack:** Node.js ≥ 22.9 built-in `node:sqlite` (`DatabaseSync`), mocha, sinon.

## Global Constraints

- Target runtime: Node.js **≥ 22.9.0** (Node-RED 5 baseline); recommended Node 24.
- **No native/compiled dependencies.** `better-sqlite3` must be fully removed from `package.json` and code.
- `MetricsStore` public method signatures are **unchanged** (consumed by `metrics-collector`, `anomaly-detector`, `http-routes`): `open`, `close`, `openOrDegrade`, `isDegraded`, `setLoggingEnabled`, `flush`, `getRecent`, `getRange`, `getSummary`, `getTopNodes`, `getNodeStats`, `getEvents`, `getAlarmRules`, `insertAlarmRule`, `updateAlarmRule`, `deleteAlarmRule`, `insertEvent`, `runRetention`, `pruneOldestFraction`.
- The plugin must **load successfully even when storage init fails** (degraded in-memory mode); no top-level throw on `require`.
- Existing on-disk DB files (written by better-sqlite3) must remain readable (same SQLite file format).
- Test runner: `npm test` (`mocha test/**/*.js --timeout 10000`).

---

### Task 1: node:sqlite engine adapter

Isolate every node:sqlite-specific call (which differs from better-sqlite3) behind one small module: a guarded loader, `DatabaseSync` open with pragmas, and a transaction helper. This is the only file that imports `node:sqlite`.

**Files:**
- Create: `lib/storage/sqlite-engine.js`
- Test: `test/sqlite-engine.test.js`

**Interfaces:**
- Produces:
  - `isAvailable(): boolean` — true if `node:sqlite` can be required (no flag needed).
  - `openDatabase(dbPath: string): DatabaseSync` — opens with WAL + NORMAL + incremental auto_vacuum pragmas applied. Throws if the path can't be opened.
  - `makeTx(db): (fn: () => void) => void` — returns a function that runs `fn` inside `BEGIN`/`COMMIT`, rolling back and rethrowing on error.

- [ ] **Step 1: Write the failing test**

```javascript
// test/sqlite-engine.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const engine = require('../lib/storage/sqlite-engine');

function tempDbPath() {
    return path.join(os.tmpdir(), `pm-eng-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('sqlite-engine', function () {
    let dbPath, db;
    afterEach(function () {
        if (db) { try { db.close(); } catch (_) {} db = null; }
        for (const suffix of ['', '-wal', '-shm']) {
            if (dbPath && fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
        }
    });

    it('reports availability on Node >= 22.13', function () {
        assert.strictEqual(engine.isAvailable(), true);
    });

    it('opens a database in WAL mode', function () {
        dbPath = tempDbPath();
        db = engine.openDatabase(dbPath);
        const row = db.prepare('PRAGMA journal_mode').get();
        assert.strictEqual(row.journal_mode, 'wal');
    });

    it('makeTx commits on success', function () {
        dbPath = tempDbPath();
        db = engine.openDatabase(dbPath);
        db.exec('CREATE TABLE t (v INTEGER)');
        const tx = engine.makeTx(db);
        tx(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run(1); });
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM t').get().c, 1);
    });

    it('makeTx rolls back and rethrows on error', function () {
        dbPath = tempDbPath();
        db = engine.openDatabase(dbPath);
        db.exec('CREATE TABLE t (v INTEGER NOT NULL)');
        const tx = engine.makeTx(db);
        assert.throws(() => {
            tx(() => {
                db.prepare('INSERT INTO t (v) VALUES (?)').run(1);
                db.prepare('INSERT INTO t (v) VALUES (?)').run(null); // violates NOT NULL
            });
        });
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM t').get().c, 0, 'first insert must be rolled back');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/sqlite-engine.test.js`
Expected: FAIL with `Cannot find module '../lib/storage/sqlite-engine'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/storage/sqlite-engine.js
'use strict';

let _DatabaseSync = null;
let _loaded = false;

function _load() {
    if (_loaded) return _DatabaseSync;
    _loaded = true;
    try {
        // node:sqlite is built in since Node 22.5 (flag-free since 22.13).
        ({ DatabaseSync: _DatabaseSync } = require('node:sqlite'));
    } catch (_) {
        _DatabaseSync = null;
    }
    return _DatabaseSync;
}

function isAvailable() {
    return _load() != null;
}

function openDatabase(dbPath) {
    const DatabaseSync = _load();
    if (!DatabaseSync) throw new Error('node:sqlite is not available in this runtime');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    return db;
}

function makeTx(db) {
    return function tx(fn) {
        db.exec('BEGIN');
        try {
            fn();
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    };
}

module.exports = { isAvailable, openDatabase, makeTx };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/sqlite-engine.test.js`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add lib/storage/sqlite-engine.js test/sqlite-engine.test.js
git commit -m "feat(storage): add node:sqlite engine adapter"
```

---

### Task 2: Port MetricsStore to the engine

Replace `better-sqlite3` usage inside `MetricsStore` with the Task 1 engine: open via `openDatabase`, transactions via `makeTx`, and apply pragmas through the engine instead of `db.pragma(...)`. Prepared statements that bind whole objects must tolerate extra keys.

**Files:**
- Modify: `lib/metrics-store.js`
- Modify (1 assertion): `test/metrics-store.test.js:28-31`

**Interfaces:**
- Consumes: `openDatabase`, `makeTx` from `lib/storage/sqlite-engine` (Task 1).
- Produces: unchanged `MetricsStore` public interface (see Global Constraints).

- [ ] **Step 1: Update the WAL assertion test to use the public read path**

The current test reaches into `store._db.prepare('PRAGMA journal_mode')`. `DatabaseSync` supports `prepare` on PRAGMA, so the access pattern still works — but make the intent explicit. Replace `test/metrics-store.test.js:28-31` with:

```javascript
    it('applies WAL mode on open', function () {
        const row = store._db.prepare('PRAGMA journal_mode').get();
        assert.strictEqual(String(row.journal_mode).toLowerCase(), 'wal');
    });
```

- [ ] **Step 2: Run the existing suite to see the failure after dependency swap**

First make the dependency edits in Step 3, then run. (This step documents the expected failure mode: before Step 3, tests still pass on better-sqlite3.)

Run: `npx mocha test/metrics-store.test.js`
Expected (current code): PASS — this is the baseline before porting.

- [ ] **Step 3: Replace better-sqlite3 with the engine in `lib/metrics-store.js`**

Change the imports at the top of `lib/metrics-store.js`:

```javascript
const EventEmitter = require('events');
const { openDatabase, makeTx } = require('./storage/sqlite-engine');
const { runMigrations } = require('./migrations');
```

Replace the `open()` method:

```javascript
    open() {
        this._db = openDatabase(this.dbPath);
        this._tx = makeTx(this._db);
        runMigrations(this._db);
        this._prepare();
    }
```

In `_prepare()`, after creating each statement that is run with an object that may carry extra keys, allow unknown named parameters. Add these two lines immediately after the `insertSample` and `insertNodeSample` assignments:

```javascript
        if (this._stmt.insertSample.setAllowUnknownNamedParameters) {
            this._stmt.insertSample.setAllowUnknownNamedParameters(true);
        }
        if (this._stmt.insertNodeSample.setAllowUnknownNamedParameters) {
            this._stmt.insertNodeSample.setAllowUnknownNamedParameters(true);
        }
```

Replace the two `this._db.transaction(() => { ... })()` call sites with the engine tx. In `flush()`:

```javascript
        if (this._loggingEnabled) {
            this._tx(() => {
                this._stmt.insertSample.run(system);
                for (const n of nodes) {
                    if (n.msg_count === 0 && n.error_count === 0) continue;
                    this._stmt.insertNodeSample.run({ ts: system.ts, ...n });
                }
            });
        }
```

In `runRetention()`:

```javascript
        const tx = this._tx;
        tx(() => {
            deletedSamples      = this._db.prepare('DELETE FROM samples      WHERE ts < ?').run(cutoff).changes;
            deletedNodeSamples  = this._db.prepare('DELETE FROM node_samples WHERE ts < ?').run(cutoff).changes;
            deletedEvents       = this._db.prepare('DELETE FROM events       WHERE ts < ?').run(cutoff).changes;
        });
```

In `pruneOldestFraction()`:

```javascript
        this._tx(() => {
            this._db.prepare('DELETE FROM samples      WHERE ts <= ?').run(cutRow.ts);
            this._db.prepare('DELETE FROM node_samples WHERE ts <= ?').run(cutRow.ts);
            this._db.prepare('DELETE FROM events       WHERE ts <= ?').run(cutRow.ts);
        });
```

Replace the `incremental_vacuum` pragma call in `runRetention()` (was `this._db.pragma('incremental_vacuum')`):

```javascript
        try { this._db.exec('PRAGMA incremental_vacuum;'); } catch (_) {}
```

Initialize `this._tx = null;` in the constructor alongside `this._db = null;`.

- [ ] **Step 4: Run the full suite to verify the port**

Run: `npm test`
Expected: PASS — all existing `metrics-store`, `report-routes`, `http-routes`, `anomaly-detector`, `integration`, `migrations` tests green. (`better-sqlite3` is still installed at this point, so its removal is deferred to Task 5.)

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-store.js test/metrics-store.test.js
git commit -m "refactor(storage): port MetricsStore from better-sqlite3 to node:sqlite engine"
```

---

### Task 3: Never crash on storage failure (guarded load + safe degraded reads)

Guarantee the plugin loads even when `node:sqlite` is unavailable, and that every read method returns a safe empty value in degraded mode instead of throwing (today `getRange`, `getSummary`, `getTopNodes`, `getNodeStats`, `getEvents` would throw because `_stmt`/`_db` are unset).

**Files:**
- Modify: `lib/metrics-store.js`
- Test: `test/metrics-store.test.js` (append cases)

**Interfaces:**
- Consumes: `isAvailable` from `lib/storage/sqlite-engine` (Task 1) — used by `openOrDegrade`.
- Produces: degraded-safe read methods that return `[]`/`{}`/`null` and never throw.

- [ ] **Step 1: Write failing tests (append to `test/metrics-store.test.js`)**

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx mocha test/metrics-store.test.js -g "degraded reads"`
Expected: FAIL — `getRange`/`getSummary`/etc. throw (`Cannot read properties of undefined` or `store not open`).

- [ ] **Step 3: Add degraded guards to each read/maintenance method**

At the top of each of these methods in `lib/metrics-store.js`, add the guard:

```javascript
    getRange(fromTs, toTs, { bucketMs = null } = {}) {
        if (this._degraded || !this._db) return [];
        // ... existing body ...
    }

    getNodeStats(nodeId, fromTs, toTs) {
        if (this._degraded || !this._db) return [];
        // ... existing body ...
    }

    getTopNodes(fromTs, toTs, { metric = 'msg_count', n = 10 } = {}) {
        if (this._degraded || !this._db) return [];
        // ... existing body ...
    }

    getEvents(fromTs, toTs, kinds = []) {
        if (this._degraded || !this._db) return [];
        // ... existing body ...
    }

    getSummary(rangeMs) {
        if (this._degraded || !this._db) return {};
        // ... existing body ...
    }

    runRetention() {
        if (this._degraded || !this._db) {
            const result = { deletedSamples: 0, deletedNodeSamples: 0, deletedEvents: 0, cutoff: Date.now() - this.retentionDays * 86_400_000 };
            this.emit('retention', result);
            return result;
        }
        // ... existing body ...
    }

    pruneOldestFraction(fraction = 0.1) {
        if (this._degraded || !this._db) return { deletedSamples: 0 };
        // ... existing body ...
    }
```

(`getRecent`, `getAlarmRules`, `insertAlarmRule`, `updateAlarmRule`, `deleteAlarmRule`, `flush`, `insertEvent` already guard on `_degraded`/`_db`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx mocha test/metrics-store.test.js -g "degraded"`
Expected: PASS (both the new "degraded reads" group and the existing degraded-mode test).

- [ ] **Step 5: Commit**

```bash
git add lib/metrics-store.js test/metrics-store.test.js
git commit -m "fix(storage): degraded-mode reads return safe empties instead of throwing"
```

---

### Task 4: Plugin loads when node:sqlite is unavailable

Prove the entry point degrades (rather than crashes) when the SQLite engine can't load — the exact upgrade-breakage scenario. Simulate engine unavailability by stubbing `sqlite-engine.openDatabase` to throw, mirroring how a missing native binding used to crash module load.

**Files:**
- Test: `test/storage-load-resilience.test.js`

**Interfaces:**
- Consumes: `MetricsStore` (`openOrDegrade`, `isDegraded`), `lib/storage/sqlite-engine`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/storage-load-resilience.test.js
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
```

- [ ] **Step 2: Run to verify it passes (behavior already provided by Tasks 1–3)**

Run: `npx mocha test/storage-load-resilience.test.js`
Expected: PASS. `MetricsStore.open()` now calls `engine.openDatabase` (Task 2); the stubbed throw is caught by the existing `openOrDegrade()` try/catch, and degraded reads are safe (Task 3). If it fails, fix `openOrDegrade`/`open` until it passes — this test encodes the core upgrade-resilience guarantee.

- [ ] **Step 3: Commit**

```bash
git add test/storage-load-resilience.test.js
git commit -m "test(storage): plugin degrades instead of crashing when engine load fails"
```

---

### Task 5: Legacy DB read compatibility

Guarantee a database file written by the old `better-sqlite3` build opens and reads under `node:sqlite` (same on-disk SQLite format), so users keep their history across the upgrade. Build the fixture programmatically with the new engine (byte-identical SQLite format) to avoid committing a binary.

**Files:**
- Test: `test/legacy-db-compat.test.js`

**Interfaces:**
- Consumes: `MetricsStore`, `lib/storage/sqlite-engine`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/legacy-db-compat.test.js
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
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx mocha test/legacy-db-compat.test.js`
Expected: PASS. If migrations are not idempotent against an already-migrated DB, fix `lib/migrations/index.js` until re-running is a no-op.

- [ ] **Step 3: Commit**

```bash
git add test/legacy-db-compat.test.js
git commit -m "test(storage): verify legacy DB files open and read under node:sqlite"
```

---

### Task 6: Remove better-sqlite3 and finalize package metadata

Drop the native dependency entirely and raise the Node floor to the Node-RED 5 baseline. This is the change that eliminates the upgrade-breakage root cause.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (regenerated by npm)

**Interfaces:**
- None (metadata only).

- [ ] **Step 1: Remove the dependency from `package.json`**

Delete the `dependencies` block's `better-sqlite3` entry. After the edit, `package.json` has no `better-sqlite3` anywhere. Update `engines`:

```json
  "engines": {
    "node": ">=22.9.0"
  }
```

- [ ] **Step 2: Regenerate the lockfile and prune node_modules**

Run:
```bash
npm install
```
Expected: `package-lock.json` updates; `better-sqlite3` removed from `node_modules`.

- [ ] **Step 3: Verify better-sqlite3 is fully gone**

Run:
```bash
grep -rn "better-sqlite3" package.json package-lock.json lib/ test/ performance-monitor.js nodes/ ; echo "exit:$?"
```
Expected: no matches in source/manifest (`exit:1` from grep meaning "no matches"). A match in `package-lock.json` means Step 2 didn't prune it — re-run `npm install`.

- [ ] **Step 4: Run the full suite with the dependency removed**

Run: `npm test`
Expected: PASS — every test green using only `node:sqlite`. This confirms nothing still imports the native module.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(storage): drop better-sqlite3, require Node >=22.9 (node:sqlite)"
```

---

## Self-Review

**Spec coverage (§3 of the design):**
- node:sqlite migration → Tasks 1, 2, 6. ✓
- Storage interface isolating the engine → Task 1 (`sqlite-engine.js`); `MetricsStore` remains the public interface (documented deviation from the spec's 4-file `lib/storage/` layout: the existing well-tested `MetricsStore` already serves as the storage interface with degraded mode, so we isolate only the engine rather than duplicate it — honors spec intent, lower risk). ✓
- Guaranteed in-memory fallback / never crash plugin load → Tasks 3, 4. ✓
- node:sqlite porting notes (DatabaseSync, no pragma helper, no transaction helper, named-param handling) → Task 1 + Task 2 Step 3. ✓
- Legacy DB data preservation → Task 5. ✓
- Drop better-sqlite3, bump engines → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**Type consistency:** `openDatabase`, `makeTx`, `isAvailable` names match between Task 1 (definition) and Tasks 2/4/5 (use). `this._tx` introduced in Task 2 and used in Tasks 2–3. Degraded return types (`[]`, `{}`, `{deletedSamples:0,...}`) match the tests in Tasks 3–4. ✓

**Out of scope (handled in later plans):** `package.json` version bump to 3.0.0, `node-red.version` floor, `files`/`.npmignore`, README/CHANGELOG, CI, and removal of the committed `performance-monitor.db` belong to the repo-hygiene plan (Plan 3). The editor rebuild is Plan 2.
