# Anomaly Detection (v2.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `lib/anomaly-detector.js` — subscribes to MetricsStore sample events, evaluates user alarm rules and 5 built-in security patterns, enforces per-metric cooldown, persists anomaly events, and fires alerts via RED runtime events and the flow node output port.

**Architecture:** `AnomalyDetector` is an EventEmitter instantiated in `performance-monitor.js` after store and collector are ready. It loads `alarm_rules` from the store on start and reloads every 60s (or immediately on `rules:changed`). Evaluators run on every `store.on('sample')` event. State is in-memory only; lost on restart (statistical baseline rebuilds over first hour).

**Tech Stack:** Node.js, EventEmitter, better-sqlite3 (via MetricsStore), Mocha/assert with sinon stubs.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `lib/anomaly-detector.js` | All detection logic, cooldown, alert dispatch |
| Modify | `performance-monitor.js` | Instantiate AnomalyDetector; wire to store + collector |
| Create | `test/anomaly-detector.test.js` | Full unit test suite |

---

## Task 1: AnomalyDetector skeleton + user alarm rule evaluator

**Files:**
- Create: `lib/anomaly-detector.js`
- Create: `test/anomaly-detector.test.js` (partial)

- [ ] **Step 1: Write failing tests for fixed-threshold user rules**

Create `test/anomaly-detector.test.js`:

```js
'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const AnomalyDetector = require('../lib/anomaly-detector');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStore(rules = []) {
    const store = new EventEmitter();
    store.getAlarmRules = () => rules;
    store.insertEvent = () => {};
    store.getEvents = () => [];
    return store;
}

function makeCollector() {
    const c = new EventEmitter();
    c.emitAlarm = (p) => c.emit('alarm', p);
    return c;
}

function makeRED() {
    const events = new EventEmitter();
    const emitted = [];
    events._emitted = emitted;
    events.emit = function(name, payload) { emitted.push({ name, payload }); EventEmitter.prototype.emit.call(this, name, payload); };
    return {
        events,
        log: { warn: () => {}, info: () => {} }
    };
}

function makeSys(overrides = {}) {
    return {
        ts: Date.now(),
        proc_cpu_pct: 10, proc_rss: 100e6, proc_heap_used: 50e6, proc_heap_total: 80e6,
        event_loop_lag: 1, sys_cpu_pct: 20, sys_mem_used: 4e9, sys_mem_total: 8e9,
        disk_used: 10e9, disk_total: 100e9, container: 0,
        ...overrides
    };
}

function emitSamples(store, detector, count, sysOverrides, intervalMs = 2000) {
    let ts = Date.now();
    for (let i = 0; i < count; i++) {
        const system = makeSys({ ts, ...sysOverrides });
        store.emit('sample', { ts, system, nodes: [] });
        ts += intervalMs;
    }
}

// ── Fixed threshold rule tests ────────────────────────────────────────────────
describe('AnomalyDetector — fixed threshold user rules', function () {
    it('no alert when metric stays below threshold', function () {
        const rule = { id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 10, enabled: 1 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        emitSamples(store, detector, 6, { proc_cpu_pct: 79 }); // below threshold
        assert.strictEqual(alarms.length, 0, 'no alarm when below threshold');
        detector.stop();
    });

    it('alert fires after sustained breach for duration_s', function () {
        const rule = { id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 10, enabled: 1 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // 6 samples × 2s = 12s > duration_s=10
        emitSamples(store, detector, 6, { proc_cpu_pct: 85 });
        assert.strictEqual(alarms.length, 1, 'one alarm after breach duration');
        assert.strictEqual(alarms[0].metric, 'proc_cpu_pct');
        assert.strictEqual(alarms[0].pattern, `rule:1`);
        assert.ok(alarms[0].value >= 85);
        detector.stop();
    });

    it('alert fires only once within cooldown window (no storm)', function () {
        const rule = { id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 10, enabled: 1 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // 30 samples — far more than enough for repeated alerts without cooldown
        emitSamples(store, detector, 30, { proc_cpu_pct: 90 });
        assert.strictEqual(alarms.length, 1, 'only one alarm in cooldown window');
        detector.stop();
    });

    it('disabled rule does not fire', function () {
        const rule = { id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 10, enabled: 0 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        emitSamples(store, detector, 10, { proc_cpu_pct: 95 });
        assert.strictEqual(alarms.length, 0, 'disabled rule must not fire');
        detector.stop();
    });

    it('alert payload includes RED runtime-event emit', function () {
        const rule = { id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 4, enabled: 1 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        emitSamples(store, detector, 3, { proc_cpu_pct: 95 });
        const redEvents = RED.events._emitted.filter(e => e.name === 'runtime-event');
        assert.ok(redEvents.length >= 1, 'RED runtime-event must be emitted');
        assert.strictEqual(redEvents[0].payload.id, 'perf-monitor:anomaly');
        detector.stop();
    });

    it('anomaly event persisted to store.insertEvent', function () {
        const rule = { id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 4, enabled: 1 };
        const store = makeStore([rule]);
        const inserted = [];
        store.insertEvent = (ev) => inserted.push(ev);
        const detector = new AnomalyDetector({ store, collector: makeCollector(), RED: makeRED() });
        detector.start();

        emitSamples(store, detector, 3, { proc_cpu_pct: 95 });
        assert.strictEqual(inserted.length, 1);
        assert.strictEqual(inserted[0].kind, 'anomaly');
        detector.stop();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --grep "fixed threshold user rules"
```

Expected: `Cannot find module '../lib/anomaly-detector'`

- [ ] **Step 3: Create `lib/anomaly-detector.js` with fixed-threshold evaluator**

```js
'use strict';
const EventEmitter = require('events');

const SEVERITY = {
    cpu_spike:     'high',
    heap_growth:   'high',
    loop_block:    'critical',
    traffic_drop:  'critical',
    traffic_spike: 'medium',
    user_fixed:    'medium',
    user_statistical: 'medium'
};

class AnomalyDetector {
    constructor({ store, collector, RED }) {
        this._store = store;
        this._collector = collector;
        this._RED = RED;

        this._rules = [];
        this._ruleWindows = new Map();      // rule_id → number[] (recent values for duration check)
        this._cooldowns = new Map();        // key → { activeUntil }

        // Rolling buffer for statistical baseline: last 1800 samples per metric
        this._baseline = new Map();         // metric → number[]

        // Built-in pattern state
        this._heapWindow = [];              // { ts, value } for slope calculation (5-min window)
        this._trafficWindow = [];           // { ts, count } 5-min window for traffic anomalies
    }

    start() {
        this._onSample = (payload) => this._evaluate(payload);
        this._store.on('sample', this._onSample);

        this._loadRules();
        this._reloadTimer = setInterval(() => this._loadRules(), 60_000);
        if (this._reloadTimer.unref) this._reloadTimer.unref();

        if (this._store.on) {
            this._onRulesChanged = () => this._loadRules();
            // RED.events fires rules:changed — store re-emits it if wired, or listen directly
        }
        if (this._RED && this._RED.events && this._RED.events.on) {
            this._RED.events.on('rules:changed', this._onRulesChanged || (() => this._loadRules()));
        }
    }

    stop() {
        if (this._onSample) this._store.off('sample', this._onSample);
        clearInterval(this._reloadTimer);
    }

    _loadRules() {
        try {
            this._rules = this._store.getAlarmRules().filter(r => r.enabled);
        } catch (err) {
            if (this._RED && this._RED.log) this._RED.log.warn(`[perf-monitor] anomaly: rule load failed: ${err.message}`);
            this._rules = [];
        }
        // Remove rule windows for rules that no longer exist
        const activeIds = new Set(this._rules.map(r => r.id));
        for (const k of this._ruleWindows.keys()) {
            if (!activeIds.has(k)) this._ruleWindows.delete(k);
        }
    }

    _isInCooldown(key) {
        const cd = this._cooldowns.get(key);
        return cd && Date.now() < cd.activeUntil;
    }

    _setCooldown(key, durationMs) {
        const cooldownMs = Math.max(durationMs * 2, 60_000);
        this._cooldowns.set(key, { activeUntil: Date.now() + cooldownMs });
    }

    _fireAlert(alert) {
        // Persist
        try {
            this._store.insertEvent({ ts: alert.ts, kind: 'anomaly', detail: alert });
        } catch (err) {
            if (this._RED && this._RED.log) this._RED.log.warn(`[perf-monitor] anomaly: insertEvent failed: ${err.message}`);
        }

        // RED notification bar
        if (this._RED && this._RED.events) {
            try {
                this._RED.events.emit('runtime-event', {
                    id: 'perf-monitor:anomaly',
                    retain: false,
                    payload: { type: 'warning', text: alert.message }
                });
            } catch (_) {}
        }

        // Flow node output
        if (this._collector) {
            try {
                this._collector.emitAlarm(alert);
            } catch (_) {}
        }
    }

    _updateBaseline(metric, value) {
        if (!this._baseline.has(metric)) this._baseline.set(metric, []);
        const buf = this._baseline.get(metric);
        buf.push(value);
        if (buf.length > 1800) buf.shift();
    }

    _baselineStats(metric) {
        const buf = this._baseline.get(metric) || [];
        if (buf.length < 30) return null;
        const mean = buf.reduce((a, v) => a + v, 0) / buf.length;
        const variance = buf.reduce((a, v) => a + (v - mean) ** 2, 0) / buf.length;
        return { mean, std: Math.sqrt(variance), n: buf.length };
    }

    _evaluate({ ts, system, nodes = [] }) {
        // Update baselines
        for (const metric of ['proc_cpu_pct', 'proc_heap_used', 'event_loop_lag', 'sys_cpu_pct']) {
            if (system[metric] != null) this._updateBaseline(metric, system[metric]);
        }

        // ── User-defined alarm rules ─────────────────────────────────────
        for (const rule of this._rules) {
            // Skip builtin-disable rules (metric starts with 'builtin:')
            if (rule.metric.startsWith('builtin:')) continue;
            try {
                this._evaluateUserRule(rule, system, ts);
            } catch (err) {
                if (this._RED && this._RED.log) this._RED.log.warn(`[perf-monitor] anomaly: rule ${rule.id} eval error: ${err.message}`);
            }
        }

        // ── Built-in security patterns ────────────────────────────────────
        const builtinDisabled = new Set(
            this._store.getAlarmRules()
                .filter(r => r.metric.startsWith('builtin:') && r.enabled === 0)
                .map(r => r.metric.replace('builtin:', ''))
        );

        if (!builtinDisabled.has('cpu_spike'))    this._evalCpuSpike(system, ts);
        if (!builtinDisabled.has('heap_growth'))  this._evalHeapGrowth(system, ts);
        if (!builtinDisabled.has('loop_block'))   this._evalLoopBlock(system, ts);
        if (!builtinDisabled.has('traffic_drop') && !builtinDisabled.has('traffic_spike')) {
            this._evalTrafficAnomalies(system, nodes, ts);
        }
    }

    _evaluateUserRule(rule, system, ts) {
        const value = system[rule.metric];
        if (value == null) return;

        const pollInterval = 2000;
        const windowSize = Math.max(1, Math.ceil((rule.duration_s * 1000) / pollInterval));

        if (!this._ruleWindows.has(rule.id)) this._ruleWindows.set(rule.id, []);
        const window = this._ruleWindows.get(rule.id);

        let breaching;
        if (rule.mode === 'fixed') {
            breaching = value > rule.threshold;
        } else {
            // statistical
            const stats = this._baselineStats(rule.metric);
            if (!stats) {
                // fallback to fixed when baseline not yet established
                breaching = rule.threshold != null && value > rule.threshold;
            } else {
                breaching = value > stats.mean + rule.threshold * stats.std;
            }
        }

        window.push(breaching ? 1 : 0);
        if (window.length > windowSize) window.shift();

        if (window.length < windowSize) return;
        const allBreaching = window.every(v => v === 1);
        if (!allBreaching) return;

        const key = `rule:${rule.id}`;
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, rule.duration_s * 1000);

        // Check deployNearby
        const deployNearby = this._checkDeployNearby(ts);

        const alert = {
            ts,
            kind: 'anomaly',
            pattern: key,
            metric: rule.metric,
            value,
            threshold: rule.threshold,
            mode: rule.mode,
            durationMs: rule.duration_s * 1000,
            severity: rule.mode === 'fixed' ? SEVERITY.user_fixed : SEVERITY.user_statistical,
            message: `${rule.metric} ${value.toFixed(2)} sustained for ${rule.duration_s}s (threshold: ${rule.threshold}, mode: ${rule.mode}).`,
            deployNearby
        };
        this._fireAlert(alert);
    }

    _checkDeployNearby(ts) {
        try {
            const events = this._store.getEvents(ts - 5 * 60_000, ts + 5 * 60_000, ['deploy']);
            return events.length > 0;
        } catch (_) { return false; }
    }

    // Built-in: CPU spike ≥ 90% for 60s
    _evalCpuSpike(system, ts) {
        const threshold = 90, duration_s = 60;
        const windowSize = Math.ceil((duration_s * 1000) / 2000);
        if (!this._cpuWindow) this._cpuWindow = [];
        this._cpuWindow.push(system.proc_cpu_pct > threshold ? 1 : 0);
        if (this._cpuWindow.length > windowSize) this._cpuWindow.shift();
        if (this._cpuWindow.length < windowSize) return;
        if (!this._cpuWindow.every(v => v === 1)) return;

        const key = 'builtin:cpu_spike';
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, duration_s * 1000);
        this._fireAlert({
            ts, kind: 'anomaly', pattern: 'cpu_spike', metric: 'proc_cpu_pct',
            value: system.proc_cpu_pct, threshold,
            mode: 'fixed', durationMs: duration_s * 1000,
            severity: SEVERITY.cpu_spike,
            message: `Process CPU ${system.proc_cpu_pct.toFixed(1)}% sustained for ${duration_s}s (threshold: ${threshold}%). Possible crypto-mining.`,
            deployNearby: this._checkDeployNearby(ts)
        });
    }

    // Built-in: heap linear slope > 20 MB/min over 5-min window
    _evalHeapGrowth(system, ts) {
        const SLOPE_LIMIT_MB_PER_MIN = 20;
        const WINDOW_MS = 5 * 60_000;
        this._heapWindow.push({ ts, value: system.proc_heap_used });
        // Trim to 5-min window
        while (this._heapWindow.length > 0 && ts - this._heapWindow[0].ts > WINDOW_MS) {
            this._heapWindow.shift();
        }
        if (this._heapWindow.length < 10) return; // need enough points

        const slope = this._linearSlopeMBPerMin(this._heapWindow);
        if (slope < SLOPE_LIMIT_MB_PER_MIN) return;

        const key = 'builtin:heap_growth';
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, WINDOW_MS);
        this._fireAlert({
            ts, kind: 'anomaly', pattern: 'heap_growth', metric: 'proc_heap_used',
            value: system.proc_heap_used, threshold: SLOPE_LIMIT_MB_PER_MIN,
            mode: 'fixed', durationMs: WINDOW_MS,
            severity: SEVERITY.heap_growth,
            message: `Heap growing at ${slope.toFixed(1)} MB/min over last 5 min (limit: ${SLOPE_LIMIT_MB_PER_MIN} MB/min). Possible memory leak.`,
            deployNearby: this._checkDeployNearby(ts)
        });
    }

    _linearSlopeMBPerMin(points) {
        const n = points.length;
        const t0 = points[0].ts;
        const xs = points.map(p => (p.ts - t0) / 60_000); // minutes
        const ys = points.map(p => p.value / 1e6);          // MB
        const meanX = xs.reduce((a, v) => a + v, 0) / n;
        const meanY = ys.reduce((a, v) => a + v, 0) / n;
        const num = xs.reduce((a, v, i) => a + (v - meanX) * (ys[i] - meanY), 0);
        const den = xs.reduce((a, v) => a + (v - meanX) ** 2, 0);
        return den === 0 ? 0 : num / den;
    }

    // Built-in: event loop lag > 500ms for 10s
    _evalLoopBlock(system, ts) {
        const threshold = 500, duration_s = 10;
        const windowSize = Math.ceil((duration_s * 1000) / 2000);
        if (!this._lagWindow) this._lagWindow = [];
        this._lagWindow.push(system.event_loop_lag > threshold ? 1 : 0);
        if (this._lagWindow.length > windowSize) this._lagWindow.shift();
        if (this._lagWindow.length < windowSize) return;
        if (!this._lagWindow.every(v => v === 1)) return;

        const key = 'builtin:loop_block';
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, duration_s * 1000);
        this._fireAlert({
            ts, kind: 'anomaly', pattern: 'loop_block', metric: 'event_loop_lag',
            value: system.event_loop_lag, threshold,
            mode: 'fixed', durationMs: duration_s * 1000,
            severity: SEVERITY.loop_block,
            message: `Event loop blocked ${system.event_loop_lag.toFixed(0)}ms for ${duration_s}s (threshold: ${threshold}ms). Possible DoS.`,
            deployNearby: this._checkDeployNearby(ts)
        });
    }

    // Built-in: traffic drop (90% vs 5-min avg) and traffic spike (baseline + 5σ)
    _evalTrafficAnomalies(system, nodes, ts) {
        const totalMsgs = nodes.reduce((a, n) => a + (n.msg_count || 0), 0);
        const WINDOW_MS = 5 * 60_000;
        this._trafficWindow.push({ ts, count: totalMsgs });
        while (this._trafficWindow.length > 0 && ts - this._trafficWindow[0].ts > WINDOW_MS) {
            this._trafficWindow.shift();
        }
        if (this._trafficWindow.length < 5) return;

        const counts = this._trafficWindow.map(p => p.count);
        const avg = counts.reduce((a, v) => a + v, 0) / counts.length;
        const std = Math.sqrt(counts.reduce((a, v) => a + (v - avg) ** 2, 0) / counts.length);

        // Drop
        if (avg > 0 && totalMsgs < avg * 0.1) {
            const key = 'builtin:traffic_drop';
            if (!this._isInCooldown(key)) {
                this._setCooldown(key, 30_000);
                this._fireAlert({
                    ts, kind: 'anomaly', pattern: 'traffic_drop', metric: 'msg_count',
                    value: totalMsgs, threshold: avg * 0.1,
                    mode: 'fixed', durationMs: 30_000,
                    severity: SEVERITY.traffic_drop,
                    message: `Message throughput dropped to ${totalMsgs} (90% below 5-min avg ${avg.toFixed(0)}). Possible crash or kill signal.`,
                    deployNearby: this._checkDeployNearby(ts)
                });
            }
        }

        // Spike
        if (std > 0 && totalMsgs > avg + 5 * std) {
            const key = 'builtin:traffic_spike';
            if (!this._isInCooldown(key)) {
                this._setCooldown(key, 30_000);
                this._fireAlert({
                    ts, kind: 'anomaly', pattern: 'traffic_spike', metric: 'msg_count',
                    value: totalMsgs, threshold: avg + 5 * std,
                    mode: 'statistical', durationMs: 30_000,
                    severity: SEVERITY.traffic_spike,
                    message: `Message throughput ${totalMsgs} is baseline + 5σ (avg=${avg.toFixed(0)}, σ=${std.toFixed(0)}).`,
                    deployNearby: this._checkDeployNearby(ts)
                });
            }
        }
    }
}

module.exports = AnomalyDetector;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- --grep "fixed threshold user rules"
```

Expected: 6 passing

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add lib/anomaly-detector.js test/anomaly-detector.test.js
git commit -m "feat: add AnomalyDetector with fixed-threshold user rule evaluator and cooldown"
```

---

## Task 2: Statistical user rule evaluator

**Files:**
- Modify: `test/anomaly-detector.test.js` (add tests)
- `lib/anomaly-detector.js` already handles statistical — tests verify it

- [ ] **Step 1: Write failing tests**

Append to `test/anomaly-detector.test.js`:

```js
describe('AnomalyDetector — statistical user rules', function () {
    it('statistical rule fires when value exceeds mean + N*std for duration', function () {
        const rule = { id: 2, metric: 'proc_cpu_pct', mode: 'statistical', threshold: 3, duration_s: 4, enabled: 1 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // Build baseline: 30 samples at 10% CPU
        emitSamples(store, detector, 30, { proc_cpu_pct: 10 });
        // Now spike: mean≈10, std≈0, so mean+3σ ≈ 10 — very high value should breach
        emitSamples(store, detector, 3, { proc_cpu_pct: 95 });

        assert.strictEqual(alarms.length, 1, 'statistical rule must fire on spike');
        assert.strictEqual(alarms[0].mode, 'statistical');
        detector.stop();
    });

    it('statistical rule falls back to fixed when baseline has < 30 samples', function () {
        const rule = { id: 3, metric: 'proc_cpu_pct', mode: 'statistical', threshold: 80, duration_s: 4, enabled: 1 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // Only 5 baseline samples (< 30) then breach — falls back to fixed with threshold=80
        emitSamples(store, detector, 5, { proc_cpu_pct: 50 });
        emitSamples(store, detector, 3, { proc_cpu_pct: 90 }); // > 80 fixed threshold

        assert.strictEqual(alarms.length, 1, 'fallback to fixed fires');
        detector.stop();
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npm test -- --grep "statistical user rules"
```

Expected: 2 passing

- [ ] **Step 3: Commit**

```bash
git add test/anomaly-detector.test.js
git commit -m "test: statistical user rule evaluator with baseline fallback"
```

---

## Task 3: Built-in security pattern tests

**Files:**
- Modify: `test/anomaly-detector.test.js`

- [ ] **Step 1: Write tests for all 5 built-in patterns**

Append to `test/anomaly-detector.test.js`:

```js
describe('AnomalyDetector — built-in CPU spike', function () {
    it('CPU spike at 90%+ for 60s fires high severity alert', function () {
        const store = makeStore([]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // 30 samples × 2s = 60s at 92%
        emitSamples(store, detector, 30, { proc_cpu_pct: 92 });
        assert.strictEqual(alarms.length, 1);
        assert.strictEqual(alarms[0].pattern, 'cpu_spike');
        assert.strictEqual(alarms[0].severity, 'high');
        detector.stop();
    });

    it('CPU spike disabled via builtin rule does not fire', function () {
        // Rule with metric='builtin:cpu_spike' and enabled=0 disables the pattern
        const rule = { id: 10, metric: 'builtin:cpu_spike', mode: 'fixed', threshold: 90, duration_s: 60, enabled: 0 };
        const store = makeStore([rule]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        emitSamples(store, detector, 30, { proc_cpu_pct: 95 });
        assert.strictEqual(alarms.length, 0, 'disabled builtin must not fire');
        detector.stop();
    });
});

describe('AnomalyDetector — built-in heap growth', function () {
    it('heap growing > 20 MB/min fires heap_growth alert', function () {
        const store = makeStore([]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // Simulate growing heap: 50MB + 2MB every 2s = 60 MB/min slope
        let ts = Date.now();
        let heap = 50e6;
        for (let i = 0; i < 20; i++) {
            const sys = makeSys({ ts, proc_heap_used: heap });
            store.emit('sample', { ts, system: sys, nodes: [] });
            heap += 2e6; // +2MB per tick (2s) = 60 MB/min
            ts += 2000;
        }
        assert.ok(alarms.some(a => a.pattern === 'heap_growth'), 'heap_growth alert must fire');
        detector.stop();
    });
});

describe('AnomalyDetector — built-in event loop block', function () {
    it('event loop lag > 500ms for 10s fires critical alert', function () {
        const store = makeStore([]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // 5 samples × 2s = 10s at 600ms lag
        emitSamples(store, detector, 5, { event_loop_lag: 600 });
        assert.strictEqual(alarms.length, 1);
        assert.strictEqual(alarms[0].pattern, 'loop_block');
        assert.strictEqual(alarms[0].severity, 'critical');
        detector.stop();
    });
});

describe('AnomalyDetector — built-in traffic anomalies', function () {
    function emitWithNodes(store, count, msgCount, intervalMs = 2000) {
        let ts = Date.now();
        for (let i = 0; i < count; i++) {
            store.emit('sample', { ts, system: makeSys({ ts }), nodes: [{ node_id: 'n1', node_type: 'http in', msg_count: msgCount, avg_process_ms: 1, error_count: 0 }] });
            ts += intervalMs;
        }
    }

    it('traffic drop to 0 fires critical alert', function () {
        const store = makeStore([]);
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        // Establish baseline: 20 msgs/tick for 10 ticks
        emitWithNodes(store, 10, 20);
        // Now drop to 0
        emitWithNodes(store, 3, 0);
        assert.ok(alarms.some(a => a.pattern === 'traffic_drop'), 'traffic_drop must fire');
        assert.ok(alarms.find(a => a.pattern === 'traffic_drop').severity === 'critical');
        detector.stop();
    });
});

describe('AnomalyDetector — deployNearby flag', function () {
    it('deployNearby true when deploy event within 5 minutes', function () {
        const rule = { id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 4, enabled: 1 };
        const ts = Date.now();
        const store = makeStore([rule]);
        store.getEvents = (from, to, kinds) => {
            if (kinds && kinds.includes('deploy')) return [{ ts, kind: 'deploy' }];
            return [];
        };
        const collector = makeCollector();
        const RED = makeRED();
        const detector = new AnomalyDetector({ store, collector, RED });
        detector.start();

        const alarms = [];
        collector.on('alarm', p => alarms.push(p));

        emitSamples(store, detector, 3, { proc_cpu_pct: 90 });
        assert.strictEqual(alarms.length, 1);
        assert.strictEqual(alarms[0].deployNearby, true);
        detector.stop();
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npm test -- --grep "AnomalyDetector"
```

Expected: all anomaly detector tests pass

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add test/anomaly-detector.test.js
git commit -m "test: built-in security pattern tests (CPU spike, heap growth, loop block, traffic)"
```

---

## Task 4: Wire AnomalyDetector into performance-monitor.js

**Files:**
- Modify: `performance-monitor.js`

- [ ] **Step 1: Instantiate and wire AnomalyDetector**

Replace the full `performance-monitor.js`:

```js
const path = require('path');
const MetricsStore = require('./lib/metrics-store');
const MetricsCollector = require('./lib/metrics-collector');
const AnomalyDetector = require('./lib/anomaly-detector');
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

    // Flow node
    RED._store = store;
    RED._collector = collector;
    require('./nodes/perf-monitor-node/perf-monitor-node')(RED);

    // Anomaly detector
    const detector = new AnomalyDetector({ store, collector, RED });
    detector.start();

    const retentionTimer = setInterval(() => {
        try { store.runRetention(); } catch (_) {}
    }, 60 * 60 * 1000);
    if (retentionTimer.unref) retentionTimer.unref();

    RED.plugins.registerPlugin('performance-monitor', {
        type: 'performance-monitor',
        onadd() { RED.log.info('[perf-monitor] plugin loaded'); }
    });

    if (RED.events && RED.events.on) {
        RED.events.on('runtime-event', (ev) => {
            if (ev && ev.id === 'shutdown') {
                clearInterval(retentionTimer);
                detector.stop();
                collector.stop();
                store.close();
            }
        });
    }

    module.exports._internal = { store, collector, detector };
};
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add performance-monitor.js
git commit -m "feat: wire AnomalyDetector into performance-monitor.js (v2.3)"
```

---

## Task 5: Bump Version to 2.3.0

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update version**

In `package.json`, change `"version": "2.2.0"` to `"version": "2.3.0"`.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 2.3.0 (anomaly detection release)"
```

---

## Self-Review Checklist

- [x] Fixed threshold: breach for `duration_s` fires alert. ✓
- [x] Cooldown: one alert per anomaly episode. ✓
- [x] Disabled rule does not fire. ✓
- [x] Statistical: fires on mean + N*σ breach; falls back to fixed < 30 samples. ✓
- [x] CPU spike: 90%, 60s, severity=high. ✓
- [x] Heap growth: slope > 20 MB/min via linear regression. ✓
- [x] Loop block: lag > 500ms, 10s, severity=critical. ✓
- [x] Traffic drop: 90% below avg, severity=critical. ✓
- [x] Traffic spike: baseline + 5σ, severity=medium. ✓
- [x] `deployNearby` flag set when deploy event within ±5min. ✓
- [x] Alert fires via `RED.events.emit('runtime-event')`. ✓
- [x] Alert fires via `collector.emitAlarm()`. ✓
- [x] `store.insertEvent` called with `kind: 'anomaly'`. ✓
- [x] Built-in disabled via `builtin:cpu_spike` alarm rule with `enabled=0`. ✓
- [x] `performance-monitor.js` instantiates detector and calls `detector.stop()` on shutdown. ✓
- [x] No placeholder steps — all code is complete. ✓
