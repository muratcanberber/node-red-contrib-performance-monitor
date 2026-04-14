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
