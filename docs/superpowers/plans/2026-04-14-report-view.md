# Report View (v2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen historical dashboard at `/performance-monitor/report` with time-series charts, custom time range selector, alarm rule management UI, and anomaly log panel.

**Architecture:** A single `lib/report-page.html` file served by a new httpAdmin route. Alarm rules are stored in SQLite via a new migration (`002-alarm-rules.js`). CRUD HTTP routes are added to `lib/http-routes.js`. SSE live updates use the existing `/performance-monitor/stream` endpoint. No build step — vanilla JS + Chart.js from CDN.

**Tech Stack:** Vanilla JS, Chart.js 4 (CDN), better-sqlite3, Node.js HTTP, Mocha/assert.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `lib/migrations/002-alarm-rules.js` | `alarm_rules` table schema |
| Modify | `lib/migrations/index.js` | Register migration 002 |
| Modify | `lib/metrics-store.js` | Add alarm_rules CRUD methods: `getAlarmRules`, `insertAlarmRule`, `updateAlarmRule`, `deleteAlarmRule` |
| Modify | `lib/http-routes.js` | Add `/report` GET route + alarm-rules CRUD routes |
| Create | `lib/report-page.html` | Full standalone dashboard (HTML + JS + CSS in one file) |
| Create | `test/report-routes.test.js` | HTTP route unit tests |

---

## Task 1: Migration 002 — alarm_rules table

**Files:**
- Create: `lib/migrations/002-alarm-rules.js`
- Modify: `lib/migrations/index.js`
- Test: `test/migrations.test.js`

- [ ] **Step 1: Write failing test**

Append to `test/migrations.test.js`:

```js
it('migration 002 creates alarm_rules table', function () {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('alarm_rules'), 'alarm_rules table must exist after migrations');
});

it('alarm_rules table has correct columns', function () {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(alarm_rules)").all().map(r => r.name);
    ['id','metric','mode','threshold','duration_s','enabled','created_at','updated_at'].forEach(col => {
        assert.ok(cols.includes(col), `column ${col} must exist`);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --grep "002 creates alarm_rules"
```

Expected: `AssertionError: alarm_rules table must exist after migrations`

- [ ] **Step 3: Create migration file**

Create `lib/migrations/002-alarm-rules.js`:

```js
module.exports = {
    version: 2,
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS alarm_rules (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                metric      TEXT NOT NULL,
                mode        TEXT NOT NULL CHECK(mode IN ('fixed','statistical')),
                threshold   REAL,
                duration_s  INTEGER NOT NULL DEFAULT 60,
                enabled     INTEGER NOT NULL DEFAULT 1,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_alarm_rules_metric ON alarm_rules(metric);
        `);
    }
};
```

- [ ] **Step 4: Register in `lib/migrations/index.js`**

```js
const migrations = [
    require('./001-initial'),
    require('./002-alarm-rules')
].sort((a, b) => a.version - b.version);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- --grep "alarm_rules"
```

Expected: 2 passing

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add lib/migrations/002-alarm-rules.js lib/migrations/index.js test/migrations.test.js
git commit -m "feat: add alarm_rules table via migration 002"
```

---

## Task 2: Alarm Rules CRUD on MetricsStore

**Files:**
- Modify: `lib/metrics-store.js`
- Test: `test/metrics-store.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/metrics-store.test.js`:

```js
describe('alarm rules CRUD', function () {
    it('getAlarmRules returns empty array on fresh DB', function () {
        const rules = store.getAlarmRules();
        assert.deepStrictEqual(rules, []);
    });

    it('insertAlarmRule creates a rule with id', function () {
        const rule = store.insertAlarmRule({
            metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80,
            duration_s: 30, enabled: 1
        });
        assert.ok(rule.id > 0, 'id must be positive integer');
        assert.strictEqual(rule.metric, 'proc_cpu_pct');
        assert.strictEqual(rule.threshold, 80);
    });

    it('getAlarmRules returns inserted rule', function () {
        store.insertAlarmRule({ metric: 'event_loop_lag', mode: 'fixed', threshold: 500, duration_s: 10, enabled: 1 });
        const rules = store.getAlarmRules();
        assert.strictEqual(rules.length, 1);
        assert.strictEqual(rules[0].metric, 'event_loop_lag');
    });

    it('updateAlarmRule changes threshold', function () {
        const created = store.insertAlarmRule({ metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 });
        const updated = store.updateAlarmRule(created.id, { threshold: 90 });
        assert.strictEqual(updated.threshold, 90);
        assert.strictEqual(updated.metric, 'proc_cpu_pct');
    });

    it('updateAlarmRule throws on unknown id', function () {
        assert.throws(() => store.updateAlarmRule(9999, { threshold: 50 }), /not found/);
    });

    it('deleteAlarmRule removes rule', function () {
        const r = store.insertAlarmRule({ metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 });
        store.deleteAlarmRule(r.id);
        assert.deepStrictEqual(store.getAlarmRules(), []);
    });

    it('deleteAlarmRule throws on unknown id', function () {
        assert.throws(() => store.deleteAlarmRule(9999), /not found/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --grep "alarm rules CRUD"
```

Expected: `TypeError: store.getAlarmRules is not a function`

- [ ] **Step 3: Add prepared statements and CRUD methods to MetricsStore**

In `_prepare()`, add after the existing statements:

```js
this._stmt.insertAlarmRule = this._db.prepare(`
    INSERT INTO alarm_rules (metric, mode, threshold, duration_s, enabled, created_at, updated_at)
    VALUES (@metric, @mode, @threshold, @duration_s, @enabled, @created_at, @updated_at)
`);
this._stmt.getAlarmRules = this._db.prepare(`SELECT * FROM alarm_rules ORDER BY id ASC`);
this._stmt.getAlarmRuleById = this._db.prepare(`SELECT * FROM alarm_rules WHERE id = ?`);
this._stmt.updateAlarmRule = this._db.prepare(`
    UPDATE alarm_rules SET metric=@metric, mode=@mode, threshold=@threshold,
    duration_s=@duration_s, enabled=@enabled, updated_at=@updated_at WHERE id=@id
`);
this._stmt.deleteAlarmRule = this._db.prepare(`DELETE FROM alarm_rules WHERE id = ?`);
```

Add the CRUD methods at the end of the class (before the closing `}`):

```js
getAlarmRules() {
    if (!this._db) return [];
    return this._stmt.getAlarmRules.all();
}

insertAlarmRule({ metric, mode, threshold = null, duration_s = 60, enabled = 1 }) {
    if (!this._db) throw new Error('store not open');
    const now = Date.now();
    const info = this._stmt.insertAlarmRule.run({ metric, mode, threshold, duration_s, enabled, created_at: now, updated_at: now });
    return this._stmt.getAlarmRuleById.get(info.lastInsertRowid);
}

updateAlarmRule(id, fields) {
    if (!this._db) throw new Error('store not open');
    const existing = this._stmt.getAlarmRuleById.get(id);
    if (!existing) throw new Error(`alarm rule ${id} not found`);
    const merged = { ...existing, ...fields, id, updated_at: Date.now() };
    this._stmt.updateAlarmRule.run(merged);
    return this._stmt.getAlarmRuleById.get(id);
}

deleteAlarmRule(id) {
    if (!this._db) throw new Error('store not open');
    const existing = this._stmt.getAlarmRuleById.get(id);
    if (!existing) throw new Error(`alarm rule ${id} not found`);
    this._stmt.deleteAlarmRule.run(id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --grep "alarm rules CRUD"
```

Expected: 7 passing

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add lib/metrics-store.js test/metrics-store.test.js
git commit -m "feat: add alarm rules CRUD methods to MetricsStore"
```

---

## Task 3: HTTP Routes — report page + alarm-rules API

**Files:**
- Modify: `lib/http-routes.js`
- Create: `test/report-routes.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/report-routes.test.js`:

```js
'use strict';
const assert = require('assert');
const { registerRoutes } = require('../lib/http-routes');

const VALID_METRICS = ['proc_cpu_pct','proc_heap_used','event_loop_lag','sys_cpu_pct','sys_mem_used'];

function makeStore(rules = []) {
    let _rules = [...rules];
    let _nextId = 1;
    return {
        getRecent: () => [],
        getRange: () => [],
        getSummary: () => ({}),
        retentionDays: 7,
        maxDbSizeMB: 500,
        on: () => {},
        off: () => {},
        isDegraded: () => false,
        getAlarmRules: () => _rules,
        insertAlarmRule: (fields) => {
            const r = { id: _nextId++, ...fields, created_at: Date.now(), updated_at: Date.now() };
            _rules.push(r);
            return r;
        },
        updateAlarmRule: (id, fields) => {
            const idx = _rules.findIndex(r => r.id === id);
            if (idx < 0) throw new Error(`alarm rule ${id} not found`);
            _rules[idx] = { ..._rules[idx], ...fields, updated_at: Date.now() };
            return _rules[idx];
        },
        deleteAlarmRule: (id) => {
            const idx = _rules.findIndex(r => r.id === id);
            if (idx < 0) throw new Error(`alarm rule ${id} not found`);
            _rules.splice(idx, 1);
        }
    };
}

function makeRED(store) {
    const routes = {};
    return {
        store,
        _routes: routes,
        httpAdmin: {
            get:    (p, fn) => { routes['GET '    + p] = fn; },
            post:   (p, fn) => { routes['POST '   + p] = fn; },
            put:    (p, fn) => { routes['PUT '    + p] = fn; },
            delete: (p, fn) => { routes['DELETE ' + p] = fn; }
        }
    };
}

function res() {
    let _body, _status = 200;
    return {
        status: function(s) { _status = s; return this; },
        json: (b) => { _body = b; },
        send: (b) => { _body = b; },
        set: () => {},
        flushHeaders: () => {},
        write: () => {},
        on: () => {},
        getBody: () => _body,
        getStatus: () => _status
    };
}

describe('report routes', function () {
    it('GET /performance-monitor/report returns 200 with HTML', function () {
        const store = makeStore();
        const RED = makeRED(store);
        registerRoutes({ RED, store, collector: null });
        const r = res();
        RED._routes['GET /performance-monitor/report']({ query: {} }, r);
        assert.strictEqual(r.getStatus(), 200);
    });

    it('GET /performance-monitor/alarm-rules returns rules array', function () {
        const store = makeStore([{ id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 }]);
        const RED = makeRED(store);
        registerRoutes({ RED, store, collector: null });
        const r = res();
        RED._routes['GET /performance-monitor/alarm-rules']({ query: {} }, r);
        const body = r.getBody();
        assert.ok(Array.isArray(body.rules), 'body.rules must be array');
        assert.strictEqual(body.rules.length, 1);
    });

    it('POST /performance-monitor/alarm-rules creates rule and returns it', function () {
        const store = makeStore();
        const RED = makeRED(store);
        registerRoutes({ RED, store, collector: null });
        const r = res();
        RED._routes['POST /performance-monitor/alarm-rules'](
            { body: { metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30 } },
            r
        );
        const body = r.getBody();
        assert.ok(body.rule.id > 0);
        assert.strictEqual(body.rule.metric, 'proc_cpu_pct');
    });

    it('POST /performance-monitor/alarm-rules returns 400 for invalid metric', function () {
        const store = makeStore();
        const RED = makeRED(store);
        registerRoutes({ RED, store, collector: null });
        const r = res();
        RED._routes['POST /performance-monitor/alarm-rules'](
            { body: { metric: 'evil_hack', mode: 'fixed', threshold: 80, duration_s: 30 } },
            r
        );
        assert.strictEqual(r.getStatus(), 400);
    });

    it('PUT /performance-monitor/alarm-rules/:id updates rule', function () {
        const store = makeStore([{ id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 }]);
        const RED = makeRED(store);
        registerRoutes({ RED, store, collector: null });
        const r = res();
        RED._routes['PUT /performance-monitor/alarm-rules/:id'](
            { params: { id: '1' }, body: { threshold: 90 } },
            r
        );
        assert.strictEqual(r.getBody().rule.threshold, 90);
    });

    it('DELETE /performance-monitor/alarm-rules/:id removes rule', function () {
        const store = makeStore([{ id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 }]);
        const RED = makeRED(store);
        registerRoutes({ RED, store, collector: null });
        const r = res();
        RED._routes['DELETE /performance-monitor/alarm-rules/:id'](
            { params: { id: '1' } },
            r
        );
        assert.strictEqual(r.getBody().ok, true);
        assert.strictEqual(store.getAlarmRules().length, 0);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --grep "report routes"
```

Expected: routes not found errors

- [ ] **Step 3: Add routes to `lib/http-routes.js`**

At the top, add:

```js
const fs = require('fs');
const path = require('path');
```

At the end of `registerRoutes`, before the closing `}`, add:

```js
    // ── Report page ──────────────────────────────────────────────────────────
    RED.httpAdmin.get('/performance-monitor/report', (req, res) => {
        const htmlPath = path.join(__dirname, 'report-page.html');
        try {
            const html = fs.readFileSync(htmlPath, 'utf8');
            res.set('Content-Type', 'text/html');
            res.send(html);
        } catch (err) {
            res.status(500).send('Report page not found');
        }
    });

    // ── Alarm rules CRUD ─────────────────────────────────────────────────────
    const VALID_METRICS = new Set([
        'proc_cpu_pct', 'proc_heap_used', 'proc_rss', 'event_loop_lag',
        'sys_cpu_pct', 'sys_mem_used', 'msg_count',
        'builtin:cpu_spike', 'builtin:heap_growth', 'builtin:loop_block',
        'builtin:traffic_drop', 'builtin:traffic_spike'
    ]);

    RED.httpAdmin.get('/performance-monitor/alarm-rules', (req, res) => {
        res.json({ rules: store.getAlarmRules() });
    });

    RED.httpAdmin.post('/performance-monitor/alarm-rules', (req, res) => {
        const { metric, mode, threshold, duration_s } = req.body || {};
        if (!VALID_METRICS.has(metric)) {
            return res.status(400).json({ error: `invalid metric: ${metric}` });
        }
        if (!['fixed', 'statistical'].includes(mode)) {
            return res.status(400).json({ error: 'mode must be fixed or statistical' });
        }
        try {
            const rule = store.insertAlarmRule({ metric, mode, threshold: threshold ?? null, duration_s: duration_s || 60, enabled: 1 });
            // Notify anomaly detector of rule change (v2.3 will listen)
            if (RED.events && RED.events.emit) RED.events.emit('rules:changed');
            res.json({ rule });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    RED.httpAdmin.put('/performance-monitor/alarm-rules/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        const fields = req.body || {};
        if (fields.metric && !VALID_METRICS.has(fields.metric)) {
            return res.status(400).json({ error: `invalid metric: ${fields.metric}` });
        }
        try {
            const rule = store.updateAlarmRule(id, fields);
            if (RED.events && RED.events.emit) RED.events.emit('rules:changed');
            res.json({ rule });
        } catch (err) {
            if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    RED.httpAdmin.delete('/performance-monitor/alarm-rules/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        try {
            store.deleteAlarmRule(id);
            if (RED.events && RED.events.emit) RED.events.emit('rules:changed');
            res.json({ ok: true });
        } catch (err) {
            if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --grep "report routes"
```

Expected: 6 passing

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add lib/http-routes.js test/report-routes.test.js
git commit -m "feat: add report page route and alarm-rules CRUD API"
```

---

## Task 4: Report Page HTML

**Files:**
- Create: `lib/report-page.html`

This is a single self-contained HTML file. No automated tests — verified manually via acceptance criteria.

- [ ] **Step 1: Create `lib/report-page.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Performance Monitor — Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --surface2: #0f3460;
    --accent: #e94560;
    --text: #eee;
    --text-dim: #888;
    --ok: #27ae60;
    --warn: #e67e22;
    --err: #e74c3c;
    --border: rgba(255,255,255,0.1);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

/* Nav */
#nav { background: var(--surface); padding: 10px 20px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; }
#nav .title { font-weight: 700; font-size: 16px; color: var(--text); }
#live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }
#live-dot.disconnected { background: var(--text-dim); }
#live-status { font-size: 12px; color: var(--text-dim); }
.time-range-btns { display: flex; gap: 6px; margin-left: auto; }
.time-range-btns button { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.time-range-btns button.active { background: var(--accent); border-color: var(--accent); }
#btn-alarms { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 4px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; }
#custom-range { display: none; align-items: center; gap: 6px; font-size: 12px; }
#custom-range input { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 3px 6px; border-radius: 4px; font-size: 12px; }
#btn-custom-apply { background: var(--accent); border: none; color: #fff; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }

/* KPI strip */
#kpi-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 16px 20px; }
.kpi-tile { background: var(--surface); border-radius: 8px; padding: 14px; border: 1px solid var(--border); }
.kpi-tile .label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .5px; }
.kpi-tile .value { font-size: 28px; font-weight: 700; margin: 4px 0; }
.kpi-tile .delta { font-size: 11px; color: var(--text-dim); }
.kpi-tile.alarm-active .value { color: var(--err); }

/* Charts grid */
#charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 20px 12px; }
.chart-card { background: var(--surface); border-radius: 8px; padding: 14px; border: 1px solid var(--border); }
.chart-card h3 { font-size: 12px; color: var(--text-dim); margin-bottom: 10px; text-transform: uppercase; letter-spacing: .5px; }
.chart-card canvas { max-height: 160px; }

/* Top nodes table */
#top-nodes-card { background: var(--surface); border-radius: 8px; padding: 14px; border: 1px solid var(--border); }
#top-nodes-card h3 { font-size: 12px; color: var(--text-dim); margin-bottom: 10px; text-transform: uppercase; letter-spacing: .5px; }
#top-nodes-table { width: 100%; border-collapse: collapse; font-size: 12px; }
#top-nodes-table th { text-align: left; padding: 4px 8px; color: var(--text-dim); border-bottom: 1px solid var(--border); }
#top-nodes-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); }

/* Anomaly log */
#anomaly-section { padding: 0 20px 20px; }
#anomaly-section summary { cursor: pointer; font-size: 13px; font-weight: 600; padding: 8px 0; user-select: none; }
#anomaly-log { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; max-height: 320px; overflow-y: auto; }
.anomaly-entry { background: var(--surface); border-radius: 6px; padding: 10px; border-left: 3px solid var(--warn); font-size: 12px; }
.anomaly-entry.critical { border-color: var(--err); }
.anomaly-entry .ae-header { display: flex; justify-content: space-between; font-weight: 600; }
.anomaly-entry .ae-msg { color: var(--text-dim); margin-top: 4px; }

/* Alarm drawer */
#alarm-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 200; }
#alarm-drawer { position: fixed; top: 0; right: -420px; width: 420px; height: 100vh; background: var(--surface); border-left: 1px solid var(--border); z-index: 201; padding: 20px; overflow-y: auto; transition: right .25s ease; }
#alarm-drawer.open { right: 0; }
#alarm-drawer h2 { font-size: 15px; margin-bottom: 16px; }
#alarm-drawer .close-btn { float: right; background: none; border: none; color: var(--text); font-size: 18px; cursor: pointer; }
.rule-row { display: flex; align-items: center; justify-content: space-between; padding: 8px; border-radius: 6px; background: var(--bg); margin-bottom: 6px; font-size: 12px; }
.rule-row .rule-info { flex: 1; }
.rule-row .rule-actions button { background: none; border: 1px solid var(--border); color: var(--text-dim); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-left: 4px; }
.rule-row .rule-actions button:hover { color: var(--err); border-color: var(--err); }
#new-rule-form { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 16px; }
#new-rule-form h3 { font-size: 13px; margin-bottom: 10px; }
#new-rule-form label { display: block; font-size: 11px; color: var(--text-dim); margin-bottom: 2px; margin-top: 8px; }
#new-rule-form select, #new-rule-form input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 6px 8px; border-radius: 4px; font-size: 12px; }
#btn-save-rule { background: var(--accent); border: none; color: #fff; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; margin-top: 12px; width: 100%; }
#rule-form-error { color: var(--err); font-size: 11px; margin-top: 6px; display: none; }
</style>
</head>
<body>

<!-- Nav -->
<nav id="nav">
    <span id="live-dot"></span>
    <span class="title">Performance Monitor</span>
    <span id="live-status">Connecting…</span>
    <div class="time-range-btns">
        <button class="active" data-range="3600000">1h</button>
        <button data-range="21600000">6h</button>
        <button data-range="86400000">24h</button>
        <button data-range="604800000">7d</button>
        <button id="btn-custom">Custom</button>
    </div>
    <div id="custom-range">
        <input type="datetime-local" id="from-dt">
        <span>—</span>
        <input type="datetime-local" id="to-dt">
        <button id="btn-custom-apply">Apply</button>
    </div>
    <button id="btn-alarms">⚙ Alarms</button>
</nav>

<!-- KPI strip -->
<div id="kpi-strip">
    <div class="kpi-tile" id="kpi-cpu">
        <div class="label">Process CPU</div>
        <div class="value" id="kpi-cpu-val">—</div>
        <div class="delta" id="kpi-cpu-delta"></div>
    </div>
    <div class="kpi-tile" id="kpi-heap">
        <div class="label">Heap Used</div>
        <div class="value" id="kpi-heap-val">—</div>
        <div class="delta" id="kpi-heap-delta"></div>
    </div>
    <div class="kpi-tile" id="kpi-lag">
        <div class="label">Event Loop Lag</div>
        <div class="value" id="kpi-lag-val">—</div>
        <div class="delta" id="kpi-lag-delta"></div>
    </div>
    <div class="kpi-tile" id="kpi-alarms">
        <div class="label">Active Alarms</div>
        <div class="value" id="kpi-alarms-val">0</div>
        <div class="delta" id="kpi-alarms-delta"></div>
    </div>
</div>

<!-- Charts -->
<div id="charts-grid">
    <div class="chart-card">
        <h3>CPU</h3>
        <canvas id="chart-cpu"></canvas>
    </div>
    <div class="chart-card">
        <h3>Memory</h3>
        <canvas id="chart-mem"></canvas>
    </div>
    <div class="chart-card">
        <h3>Event Loop Lag</h3>
        <canvas id="chart-lag"></canvas>
    </div>
    <div class="chart-card" id="top-nodes-card">
        <h3>Top Nodes</h3>
        <table id="top-nodes-table">
            <thead><tr><th>Node</th><th>Type</th><th>Msgs</th><th>Avg ms</th><th>Errors</th></tr></thead>
            <tbody id="top-nodes-tbody"></tbody>
        </table>
    </div>
</div>

<!-- Anomaly log -->
<details id="anomaly-section" open>
    <summary>Anomaly Log</summary>
    <div id="anomaly-log"><p style="color:var(--text-dim);font-size:12px;">No anomalies detected.</p></div>
</details>

<!-- Alarm backdrop + drawer -->
<div id="alarm-backdrop"></div>
<div id="alarm-drawer">
    <button class="close-btn" id="btn-close-alarms">×</button>
    <h2>Alarm Rules</h2>
    <div id="rules-list"></div>
    <div id="new-rule-form">
        <h3>New Alarm Rule</h3>
        <label>Metric</label>
        <select id="rule-metric">
            <option value="proc_cpu_pct">Process CPU %</option>
            <option value="proc_heap_used">Heap Used (bytes)</option>
            <option value="event_loop_lag">Event Loop Lag (ms)</option>
            <option value="sys_cpu_pct">System CPU %</option>
            <option value="sys_mem_used">System Memory Used</option>
        </select>
        <label>Mode</label>
        <select id="rule-mode">
            <option value="fixed">Fixed threshold</option>
            <option value="statistical">Statistical (auto-baseline, N × σ)</option>
        </select>
        <label id="label-threshold">Threshold</label>
        <input type="number" id="rule-threshold" placeholder="e.g. 80">
        <label>Duration (seconds metric must breach)</label>
        <input type="number" id="rule-duration" value="60" min="1">
        <div id="rule-form-error"></div>
        <button id="btn-save-rule">Save Rule</button>
    </div>
</div>

<script>
(function () {
'use strict';

// ── Chart helpers ─────────────────────────────────────────────────────────────
const MAX_POINTS = 300;

function makeChart(id, datasets, yLabel) {
    const ctx = document.getElementById(id).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: datasets.map(d => ({
            label: d.label,
            data: [],
            borderColor: d.color,
            backgroundColor: d.color + '22',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            fill: false
        })) },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: { legend: { labels: { color: '#aaa', font: { size: 10 } } } },
            scales: {
                x: { ticks: { color: '#666', maxTicksLimit: 6, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { ticks: { color: '#888', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: !!yLabel, text: yLabel, color: '#666', font: { size: 9 } } }
            }
        }
    });
}

const chartCpu = makeChart('chart-cpu', [
    { label: 'Proc CPU %', color: '#3498db' },
    { label: 'Sys CPU %',  color: '#9b59b6' }
], '%');
const chartMem = makeChart('chart-mem', [
    { label: 'Heap Used MB', color: '#27ae60' },
    { label: 'RSS MB',       color: '#e67e22' }
], 'MB');
const chartLag = makeChart('chart-lag', [
    { label: 'Event Loop Lag ms', color: '#e74c3c' }
], 'ms');

function pushToChart(chart, label, ...values) {
    chart.data.labels.push(label);
    values.forEach((v, i) => chart.data.datasets[i].data.push(v));
    if (chart.data.labels.length > MAX_POINTS) {
        chart.data.labels.shift();
        chart.data.datasets.forEach(d => d.data.shift());
    }
    chart.update('none');
}

function sampleToCharts(s) {
    const ts = new Date(s.ts).toLocaleTimeString();
    pushToChart(chartCpu, ts, s.proc_cpu_pct, s.sys_cpu_pct);
    pushToChart(chartMem, ts, s.proc_heap_used / 1e6, s.proc_rss / 1e6);
    pushToChart(chartLag, ts, s.event_loop_lag);
}

// ── KPI tiles ─────────────────────────────────────────────────────────────────
let _prevCpu = null, _prevHeap = null;
function updateKpi(s) {
    const heapMB = (s.proc_heap_used / 1e6).toFixed(1);
    document.getElementById('kpi-cpu-val').textContent = s.proc_cpu_pct.toFixed(1) + '%';
    document.getElementById('kpi-heap-val').textContent = heapMB + ' MB';
    document.getElementById('kpi-lag-val').textContent = s.event_loop_lag.toFixed(1) + ' ms';
    if (_prevCpu !== null) {
        const diff = (s.proc_cpu_pct - _prevCpu).toFixed(1);
        document.getElementById('kpi-cpu-delta').textContent = (diff >= 0 ? '+' : '') + diff + '% vs start';
    }
    _prevCpu = s.proc_cpu_pct;
    _prevHeap = s.proc_heap_used;
}

// ── Top nodes ─────────────────────────────────────────────────────────────────
function renderTopNodes(nodes) {
    const tbody = document.getElementById('top-nodes-tbody');
    if (!nodes || nodes.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-dim)">No node data</td></tr>'; return; }
    tbody.innerHTML = nodes.map(n => `
        <tr>
            <td style="font-family:monospace;font-size:10px">${n.id || n.node_id}</td>
            <td>${n.type || n.node_type}</td>
            <td>${n.msgCount || n.msg_count || 0}</td>
            <td>${(n.avgMs || n.avg_process_ms || 0).toFixed(1)}</td>
            <td style="color:${(n.errors || n.error_count) > 0 ? 'var(--err)' : 'inherit'}">${n.errors || n.error_count || 0}</td>
        </tr>`).join('');
}

// ── Anomaly log ───────────────────────────────────────────────────────────────
let _anomalyCount = 0;

function prependAnomaly(a) {
    const log = document.getElementById('anomaly-log');
    // Remove placeholder
    if (log.querySelector('p')) log.innerHTML = '';
    _anomalyCount++;
    document.getElementById('kpi-alarms-val').textContent = _anomalyCount;
    document.getElementById('kpi-alarms').classList.add('alarm-active');
    const entry = document.createElement('div');
    entry.className = 'anomaly-entry' + (a.severity === 'critical' ? ' critical' : '');
    entry.innerHTML = `
        <div class="ae-header">
            <span>${a.pattern || a.kind}</span>
            <span style="color:var(--text-dim);font-size:10px">${new Date(a.ts).toLocaleTimeString()}</span>
        </div>
        <div class="ae-msg">${a.message || ''}</div>`;
    log.prepend(entry);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
let _evtSource;

function connectSSE() {
    _evtSource = new EventSource('/performance-monitor/stream');
    _evtSource.addEventListener('sample', (e) => {
        const data = JSON.parse(e.data);
        const sys = data.system || data;
        updateKpi(sys);
        sampleToCharts(sys);
        if (data.nodes && data.nodes.length) renderTopNodes(data.nodes);
    });
    _evtSource.addEventListener('event', (e) => {
        const ev = JSON.parse(e.data);
        if (ev.kind === 'anomaly') prependAnomaly(ev.detail || ev);
    });
    _evtSource.onopen = () => {
        document.getElementById('live-dot').className = '';
        document.getElementById('live-status').textContent = 'Live';
    };
    _evtSource.onerror = () => {
        document.getElementById('live-dot').className = 'disconnected';
        document.getElementById('live-status').textContent = 'Disconnected — retrying…';
        _evtSource.close();
        setTimeout(connectSSE, 5000);
    };
}

// ── Historical range fetch ────────────────────────────────────────────────────
let _currentRangeMs = 3600000;

function loadRange(fromMs, toMs) {
    const dur = toMs - fromMs;
    const bucket = dur < 2 * 3600000 ? 10000 : dur < 86400000 ? 60000 : 600000;
    fetch(`/performance-monitor/range?from=${fromMs}&to=${toMs}&bucket=${bucket}`)
        .then(r => r.json())
        .then(data => {
            const rows = data.rows || [];
            // Clear charts
            [chartCpu, chartMem, chartLag].forEach(c => {
                c.data.labels = [];
                c.data.datasets.forEach(d => { d.data = []; });
            });
            rows.forEach(s => sampleToCharts(s));
            [chartCpu, chartMem, chartLag].forEach(c => c.update());
        });
}

function applyRange(rangeMs) {
    _currentRangeMs = rangeMs;
    const now = Date.now();
    loadRange(now - rangeMs, now);
}

// ── Time range buttons ────────────────────────────────────────────────────────
document.querySelectorAll('.time-range-btns button').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.time-range-btns button').forEach(b => b.classList.remove('active'));
        if (btn.id === 'btn-custom') {
            document.getElementById('custom-range').style.display = 'flex';
        } else {
            btn.classList.add('active');
            document.getElementById('custom-range').style.display = 'none';
            applyRange(parseInt(btn.dataset.range, 10));
        }
    });
});

document.getElementById('btn-custom-apply').addEventListener('click', () => {
    const from = new Date(document.getElementById('from-dt').value).getTime();
    const to = new Date(document.getElementById('to-dt').value).getTime();
    if (from && to && to > from) loadRange(from, to);
});

// ── Alarm drawer ──────────────────────────────────────────────────────────────
function openAlarms() {
    document.getElementById('alarm-backdrop').style.display = 'block';
    document.getElementById('alarm-drawer').classList.add('open');
    loadAlarmRules();
}
function closeAlarms() {
    document.getElementById('alarm-backdrop').style.display = 'none';
    document.getElementById('alarm-drawer').classList.remove('open');
}
document.getElementById('btn-alarms').addEventListener('click', openAlarms);
document.getElementById('btn-close-alarms').addEventListener('click', closeAlarms);
document.getElementById('alarm-backdrop').addEventListener('click', closeAlarms);

function loadAlarmRules() {
    fetch('/performance-monitor/alarm-rules')
        .then(r => r.json())
        .then(data => renderRules(data.rules || []));
}

function renderRules(rules) {
    const list = document.getElementById('rules-list');
    if (rules.length === 0) { list.innerHTML = '<p style="font-size:12px;color:var(--text-dim)">No rules configured.</p>'; return; }
    list.innerHTML = rules.map(r => `
        <div class="rule-row" data-id="${r.id}">
            <div class="rule-info">
                <b>${r.metric}</b> — ${r.mode === 'fixed' ? '> ' + r.threshold : 'baseline + ' + r.threshold + 'σ'} for ${r.duration_s}s
                <span style="margin-left:6px;color:${r.enabled ? 'var(--ok)' : 'var(--text-dim)'}">●</span>
            </div>
            <div class="rule-actions">
                <button onclick="toggleRule(${r.id},${r.enabled ? 0 : 1})">${r.enabled ? 'Disable' : 'Enable'}</button>
                <button onclick="deleteRule(${r.id})">Delete</button>
            </div>
        </div>`).join('');
}

window.toggleRule = function(id, enabled) {
    fetch('/performance-monitor/alarm-rules/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) })
        .then(() => loadAlarmRules());
};
window.deleteRule = function(id) {
    fetch('/performance-monitor/alarm-rules/' + id, { method: 'DELETE' })
        .then(() => loadAlarmRules());
};

// Mode label update
document.getElementById('rule-mode').addEventListener('change', function() {
    document.getElementById('label-threshold').textContent =
        this.value === 'statistical' ? 'Standard deviations (N)' : 'Threshold';
});

document.getElementById('btn-save-rule').addEventListener('click', () => {
    const metric = document.getElementById('rule-metric').value;
    const mode = document.getElementById('rule-mode').value;
    const threshold = parseFloat(document.getElementById('rule-threshold').value);
    const duration_s = parseInt(document.getElementById('rule-duration').value, 10);
    const errEl = document.getElementById('rule-form-error');
    errEl.style.display = 'none';
    fetch('/performance-monitor/alarm-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metric, mode, threshold, duration_s })
    }).then(r => r.json()).then(data => {
        if (data.error) { errEl.textContent = data.error; errEl.style.display = 'block'; return; }
        loadAlarmRules();
    });
});

// ── Init ──────────────────────────────────────────────────────────────────────
applyRange(_currentRangeMs);
connectSSE();

})();
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the route can serve the file**

```bash
npm test -- --grep "GET /performance-monitor/report"
```

Expected: 1 passing (route returns 200 — test already written in Task 3)

- [ ] **Step 3: Commit**

```bash
git add lib/report-page.html
git commit -m "feat: add standalone historical dashboard at /performance-monitor/report"
```

---

## Task 5: Bump Version to 2.2.0

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update version**

In `package.json`, change `"version": "2.1.0"` to `"version": "2.2.0"`.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 2.2.0 (report view release)"
```

---

## Self-Review Checklist

- [x] Migration 002 creates `alarm_rules` table with correct columns. ✓
- [x] `MetricsStore` has all 4 CRUD methods. ✓
- [x] `GET /performance-monitor/report` serves HTML. ✓
- [x] Alarm CRUD routes: GET/POST/PUT/DELETE. ✓
- [x] POST 400 on invalid metric. ✓
- [x] `RED.events.emit('rules:changed')` fired on CRUD (anomaly detector v2.3 will listen). ✓
- [x] Chart.js loaded from CDN (pinned 4.4.0). ✓
- [x] SSE retries after 5s disconnect. ✓
- [x] Time range buttons load bucketed historical data. ✓
- [x] No placeholder steps. ✓
