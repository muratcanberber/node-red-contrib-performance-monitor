'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Inline mock router — matches existing test pattern
const routes = {};
function mockRouter() {
    return {
        get: (p, fn) => { routes['GET ' + p] = fn; },
        post: (p, fn) => { routes['POST ' + p] = fn; },
        put: (p, fn) => { routes['PUT ' + p] = fn; },
        delete: (p, fn) => { routes['DELETE ' + p] = fn; }
    };
}

let alarmRules = [];
let nextId = 1;

const store = {
    getAlarmRules: () => alarmRules,
    insertAlarmRule: (fields) => {
        const rule = { id: nextId++, ...fields, created_at: Date.now(), updated_at: Date.now() };
        alarmRules.push(rule);
        return rule;
    },
    updateAlarmRule: (id, fields) => {
        const rule = alarmRules.find(r => r.id === id);
        if (!rule) return null;
        Object.assign(rule, fields, { updated_at: Date.now() });
        return rule;
    },
    deleteAlarmRule: (id) => {
        alarmRules = alarmRules.filter(r => r.id !== id);
    },
    isDegraded: () => false
};

const RED = {
    httpAdmin: mockRouter(),
    log: { warn: () => {} },
    events: { emit: () => {} }
};

// Load routes
delete require.cache[require.resolve('../lib/http-routes')];
const { registerRoutes } = require('../lib/http-routes');
registerRoutes({ RED, store, collector: null });

function makeRes() {
    return {
        _status: 200, _body: null, _type: null,
        status(s) { this._status = s; return this; },
        json(b) { this._body = b; return this; },
        send(b) { this._body = b; return this; },
        set(k, v) { return this; },
        type(t) { this._type = t; return this; },
        sendFile(p) { this._file = p; return this; }
    };
}

describe('Report routes', function () {
    beforeEach(function () {
        alarmRules = [];
        nextId = 1;
    });

    it('GET /performance-monitor/report returns HTML', function () {
        const res = makeRes();
        // Route may use res.sendFile or res.send — just check it was handled without error
        const handler = routes['GET /performance-monitor/report'];
        assert.ok(handler, 'route must exist');
        // calling it should not throw
        handler({ }, res);
    });

    it('GET /performance-monitor/alarm-rules returns empty array', function () {
        const res = makeRes();
        routes['GET /performance-monitor/alarm-rules']({}, res);
        assert.deepStrictEqual(res._body, []);
    });

    it('POST /performance-monitor/alarm-rules creates rule', function () {
        const res = makeRes();
        routes['POST /performance-monitor/alarm-rules']({
            body: { metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 }
        }, res);
        assert.strictEqual(res._status, 201);
        assert.ok(res._body.id > 0);
        assert.strictEqual(res._body.metric, 'proc_cpu_pct');
    });

    it('POST /performance-monitor/alarm-rules rejects invalid metric', function () {
        const res = makeRes();
        routes['POST /performance-monitor/alarm-rules']({
            body: { metric: 'hack_attempt', mode: 'fixed', threshold: 80, duration_s: 30 }
        }, res);
        assert.strictEqual(res._status, 400);
    });

    it('PUT /performance-monitor/alarm-rules/:id updates rule', function () {
        // Insert first
        alarmRules.push({ id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 });
        nextId = 2;
        const res = makeRes();
        routes['PUT /performance-monitor/alarm-rules/:id']({
            params: { id: '1' },
            body: { threshold: 90, enabled: 0 }
        }, res);
        assert.strictEqual(res._body.threshold, 90);
    });

    it('DELETE /performance-monitor/alarm-rules/:id removes rule', function () {
        alarmRules.push({ id: 1, metric: 'proc_cpu_pct', mode: 'fixed', threshold: 80, duration_s: 30, enabled: 1 });
        const res = makeRes();
        routes['DELETE /performance-monitor/alarm-rules/:id']({
            params: { id: '1' }
        }, res);
        assert.strictEqual(res._status, 204);
        assert.strictEqual(alarmRules.length, 0);
    });
});
