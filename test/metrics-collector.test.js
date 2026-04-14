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
        c.stop();
    });
});

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

    afterEach(function () {
        collector.stop();
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
            collector.stop();
            done();
        });
        collector.attachLifecycleListeners();
        handlers['flows:started']({ config: {} });
    });
});
