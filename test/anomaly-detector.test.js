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
