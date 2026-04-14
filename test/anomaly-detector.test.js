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
