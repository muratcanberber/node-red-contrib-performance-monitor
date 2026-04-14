function registerRoutes(options) {
    const RED = options.RED;
    const store = options.store;
    const getSettings = options.getSettings || function () { return {}; };
    const updateSettings = options.updateSettings || function () { return getSettings(); };

    RED.httpAdmin.get('/performance-monitor/recent', function (req, res) {
        const limit = Math.min(1000, parseInt(req.query.limit, 10) || 300);
        res.json({ samples: store.getRecent(limit) });
    });

    RED.httpAdmin.get('/performance-monitor/range', function (req, res) {
        const fromTs = parseInt(req.query.from, 10);
        const toTs = parseInt(req.query.to, 10);
        const bucketMs = req.query.bucket ? parseInt(req.query.bucket, 10) : null;

        if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) {
            res.status(400).json({ error: 'from and to required' });
            return;
        }

        res.json({ rows: store.getRange(fromTs, toTs, { bucketMs: bucketMs }) });
    });

    RED.httpAdmin.get('/performance-monitor/summary', function (req, res) {
        const rangeMs = parseInt(req.query.range, 10) || 60_000 * 5;
        res.json({ summary: store.getSummary(rangeMs) });
    });

    RED.httpAdmin.get('/performance-monitor/settings', function (req, res) {
        res.json(getSettings());
    });

    RED.httpAdmin.post('/performance-monitor/settings', function (req, res) {
        res.json(updateSettings(req.body || {}));
    });

    RED.httpAdmin.get('/performance-monitor/stream', function (req, res) {
        if (typeof res.set === 'function') {
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
        }

        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        const onSample = function (payload) {
            res.write(`event: sample\ndata: ${JSON.stringify(payload)}\n\n`);
        };

        const onEvent = function (payload) {
            res.write(`event: event\ndata: ${JSON.stringify(payload)}\n\n`);
        };

        store.on('sample', onSample);
        store.on('event', onEvent);

        req.on('close', function () {
            store.off('sample', onSample);
            store.off('event', onEvent);
        });
    });
}

module.exports = { registerRoutes };
