'use strict';
const assert = require('assert');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// Minimal RED / store / collector mocks
// ---------------------------------------------------------------------------
function makeStore(recentSample) {
    const store = new EventEmitter();
    store.isDegraded = () => false;
    store.setLoggingEnabled = (v) => { store._loggingEnabled = v; };
    store._loggingEnabled = true;
    store.getRecent = (n) => recentSample ? [recentSample] : [];
    return store;
}

function makeCollector(liveSystem) {
    const collector = new EventEmitter();
    collector.sampleSystem = () => liveSystem || makeSys();
    return collector;
}

function makeSys(overrides = {}) {
    return {
        ts: Date.now(),
        proc_cpu_pct: 10, proc_rss: 100e6, proc_heap_used: 50e6, proc_heap_total: 80e6,
        event_loop_lag: 1.2, sys_cpu_pct: 30, sys_mem_used: 4e9, sys_mem_total: 8e9,
        disk_used: 10e9, disk_total: 100e9, container: 0,
        ...overrides
    };
}

function makeRED({ store, collector } = {}) {
    const nodes = {};
    const RED = {
        nodes: {
            createNode: (node, config) => {
                node.status = () => {};
                node.on = (ev, fn) => { nodes[ev] = fn; };
                node._handlers = nodes;
            },
            registerType: (type, ctor) => { RED._nodeType = type; RED._NodeCtor = ctor; }
        },
        log: { warn: () => {} },
        _store: store,
        _collector: collector
    };
    return RED;
}

// Require after mocks so module can be loaded
function loadNode() {
    delete require.cache[require.resolve('../nodes/perf-monitor-node/perf-monitor-node')];
    return require('../nodes/perf-monitor-node/perf-monitor-node');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PerfMonitorNode', function () {
    it('registers node type "perf-monitor"', function () {
        const store = makeStore(makeSys());
        const collector = makeCollector();
        const RED = makeRED({ store, collector });
        loadNode()(RED);
        assert.strictEqual(RED._nodeType, 'perf-monitor');
    });

    it('inject-driven: on input returns payload with correct shape', function (done) {
        const sys = makeSys({ proc_cpu_pct: 42 });
        const store = makeStore(sys);
        const collector = makeCollector(sys);
        const RED = makeRED({ store, collector });
        loadNode()(RED);

        const config = { name: '', mode: 'inject', interval: 2000, includeNodeStats: true, disableLogging: false };
        const node = { send: (msg) => {
            assert.ok(msg.payload, 'payload present');
            assert.strictEqual(msg.payload.process.cpu, 42);
            assert.strictEqual(msg.topic, 'perf-monitor');
            assert.strictEqual(msg.payload.source, 'perf-monitor');
            done();
        }};
        RED._NodeCtor.call(node, config);
        // simulate inject
        node._handlers.input({ _msgid: '1' }, () => {}, () => {});
    });

    it('interval mode: subscribes to store sample and sends msg', function (done) {
        const sys = makeSys({ proc_cpu_pct: 55 });
        const store = makeStore(sys);
        const collector = makeCollector(sys);
        const RED = makeRED({ store, collector });
        loadNode()(RED);

        const config = { mode: 'interval', interval: 2000, includeNodeStats: true, disableLogging: false };
        const node = { send: (msg) => {
            assert.strictEqual(msg.payload.process.cpu, 55);
            done();
        }};
        RED._NodeCtor.call(node, config);
        // simulate sample event
        store.emit('sample', { ts: sys.ts, system: sys, nodes: [] });
    });

    it('nodes array present when includeNodeStats true', function (done) {
        const sys = makeSys();
        const nodeData = [{ node_id: 'n1', node_type: 'function', msg_count: 5, avg_process_ms: 1, error_count: 0 }];
        const store = makeStore(sys);
        const collector = makeCollector(sys);
        const RED = makeRED({ store, collector });
        loadNode()(RED);

        const config = { mode: 'interval', includeNodeStats: true, disableLogging: false };
        const node = { send: (msg) => {
            assert.ok(Array.isArray(msg.payload.nodes));
            done();
        }};
        RED._NodeCtor.call(node, config);
        store.emit('sample', { ts: sys.ts, system: sys, nodes: nodeData });
    });

    it('nodes array empty when includeNodeStats false', function (done) {
        const sys = makeSys();
        const store = makeStore(sys);
        const collector = makeCollector(sys);
        const RED = makeRED({ store, collector });
        loadNode()(RED);

        const config = { mode: 'interval', includeNodeStats: false, disableLogging: false };
        const node = { send: (msg) => {
            assert.deepStrictEqual(msg.payload.nodes, []);
            done();
        }};
        RED._NodeCtor.call(node, config);
        store.emit('sample', { ts: sys.ts, system: sys, nodes: [{ node_id: 'x', msg_count: 1 }] });
    });

    it('disableLogging calls store.setLoggingEnabled(false)', function () {
        const sys = makeSys();
        const store = makeStore(sys);
        const collector = makeCollector(sys);
        const RED = makeRED({ store, collector });
        loadNode()(RED);

        const config = { mode: 'inject', disableLogging: true };
        const node = { send: () => {} };
        RED._NodeCtor.call(node, config);
        assert.strictEqual(store._loggingEnabled, false);
    });

    it('alarm from collector forwarded to node output', function (done) {
        const sys = makeSys();
        const store = makeStore(sys);
        const collector = makeCollector(sys);
        const RED = makeRED({ store, collector });
        loadNode()(RED);

        const alarmPayload = { ts: Date.now(), kind: 'anomaly', pattern: 'cpu_spike', metric: 'proc_cpu_pct', value: 92 };
        const config = { mode: 'interval', includeNodeStats: false, disableLogging: false };
        const node = { send: (msg) => {
            assert.strictEqual(msg.topic, 'perf-monitor:alarm');
            assert.deepStrictEqual(msg.payload, alarmPayload);
            done();
        }};
        RED._NodeCtor.call(node, config);
        collector.emit('alarm', alarmPayload);
    });
});
