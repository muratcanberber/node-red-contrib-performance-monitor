const assert = require('assert');
const EventEmitter = require('events');
const { registerRoutes } = require('../lib/http-routes');

describe('http-routes', function () {
    it('registers recent, settings, and stream routes', function () {
        const routes = {};
        const RED = {
            httpAdmin: {
                get: function (routePath, handler) {
                    routes[`GET ${routePath}`] = handler;
                },
                post: function (routePath, handler) {
                    routes[`POST ${routePath}`] = handler;
                }
            }
        };
        const store = new EventEmitter();
        store.getRecent = function () { return []; };
        store.getRange = function () { return []; };
        store.getSummary = function () { return {}; };

        registerRoutes({ RED: RED, store: store });

        assert.ok(routes['GET /performance-monitor/recent']);
        assert.ok(routes['GET /performance-monitor/settings']);
        assert.ok(routes['POST /performance-monitor/settings']);
        assert.ok(routes['GET /performance-monitor/stream']);
    });

    it('/recent handler responds with samples', function () {
        const routes = {};
        const RED = {
            httpAdmin: {
                get: function (routePath, handler) {
                    routes[`GET ${routePath}`] = handler;
                },
                post: function () {}
            }
        };
        const store = new EventEmitter();
        store.getRecent = function () {
            return [{ ts: 1, proc_cpu_pct: 5 }];
        };
        store.getRange = function () { return []; };
        store.getSummary = function () { return {}; };

        registerRoutes({ RED: RED, store: store });

        let body;
        routes['GET /performance-monitor/recent'](
            { query: {} },
            { json: function (payload) { body = payload; } }
        );

        assert.deepStrictEqual(body, { samples: [{ ts: 1, proc_cpu_pct: 5 }] });
    });

    it('POST /settings updates retentionDays on store-backed settings', function () {
        const routes = {};
        const RED = {
            httpAdmin: {
                get: function (routePath, handler) {
                    routes[`GET ${routePath}`] = handler;
                },
                post: function (routePath, handler) {
                    routes[`POST ${routePath}`] = handler;
                }
            }
        };
        const store = new EventEmitter();
        const settings = { retentionDays: 7, maxDbSizeMB: 500 };
        store.getRecent = function () { return []; };
        store.getRange = function () { return []; };
        store.getSummary = function () { return {}; };

        registerRoutes({
            RED: RED,
            store: store,
            getSettings: function () {
                return settings;
            },
            updateSettings: function (patch) {
                Object.assign(settings, patch);
                return settings;
            }
        });

        let body;
        routes['POST /performance-monitor/settings'](
            { body: { retentionDays: 30 } },
            { json: function (payload) { body = payload; } }
        );

        assert.strictEqual(body.retentionDays, 30);
        assert.strictEqual(settings.retentionDays, 30);
    });
});
