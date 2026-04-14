const assert = require('assert');
const { registerRoutes } = require('../lib/http-routes');

describe('http-routes', function () {
    it('registers /performance-monitor/recent on RED.httpAdmin', function () {
        const routes = {};
        const RED = { httpAdmin: {
            get: (path, fn) => { routes[path] = fn; },
            post: (path, fn) => { routes['POST ' + path] = fn; },
            put: (path, fn) => { routes['PUT ' + path] = fn; },
            delete: (path, fn) => { routes['DELETE ' + path] = fn; }
        }};
        const store = { getRecent: () => [], retentionDays: 7, maxDbSizeMB: 500 };
        registerRoutes({ RED, store });
        assert.ok('/performance-monitor/recent' in routes);
        assert.ok('/performance-monitor/stream' in routes);
    });

    it('/recent handler responds with samples', function () {
        const routes = {};
        const RED = { httpAdmin: {
            get: (path, fn) => { routes[path] = fn; },
            post: (path, fn) => { routes['POST ' + path] = fn; },
            put: (path, fn) => { routes['PUT ' + path] = fn; },
            delete: (path, fn) => { routes['DELETE ' + path] = fn; }
        }};
        const store = { getRecent: (n) => [{ ts: 1, proc_cpu_pct: 5 }], retentionDays: 7, maxDbSizeMB: 500 };
        registerRoutes({ RED, store });

        let body;
        routes['/performance-monitor/recent'](
            { query: {} },
            { json: (b) => { body = b; } }
        );
        assert.deepStrictEqual(body, { samples: [{ ts: 1, proc_cpu_pct: 5 }] });
    });

    it('POST /settings updates retentionDays on store', function () {
        const routes = {};
        const RED = { httpAdmin: {
            get: (p, fn) => { routes['GET ' + p] = fn; },
            post: (p, fn) => { routes['POST ' + p] = fn; },
            put: (p, fn) => { routes['PUT ' + p] = fn; },
            delete: (p, fn) => { routes['DELETE ' + p] = fn; }
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
});
