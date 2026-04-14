function registerRoutes({ RED, store, collector }) {
    RED.httpAdmin.get('/performance-monitor/recent', (req, res) => {
        const limit = Math.min(1000, parseInt(req.query.limit, 10) || 300);
        res.json({ samples: store.getRecent(limit) });
    });

    RED.httpAdmin.get('/performance-monitor/range', (req, res) => {
        const from = parseInt(req.query.from, 10);
        const to = parseInt(req.query.to, 10);
        const bucket = req.query.bucket ? parseInt(req.query.bucket, 10) : null;
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
            return res.status(400).json({ error: 'from and to required' });
        }
        res.json({ rows: store.getRange(from, to, { bucketMs: bucket }) });
    });

    RED.httpAdmin.get('/performance-monitor/summary', (req, res) => {
        const range = parseInt(req.query.range, 10) || 60_000 * 5;
        res.json({ summary: store.getSummary(range) });
    });

    RED.httpAdmin.get('/performance-monitor/stream', (req, res) => {
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.flushHeaders();

        const onSample = (payload) => {
            res.write(`event: sample\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        const onEvent = (payload) => {
            res.write(`event: event\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        store.on('sample', onSample);
        store.on('event', onEvent);

        req.on('close', () => {
            store.off('sample', onSample);
            store.off('event', onEvent);
        });
    });

    RED.httpAdmin.get('/performance-monitor/settings', (req, res) => {
        res.json({ retentionDays: store.retentionDays, maxDbSizeMB: store.maxDbSizeMB });
    });

    RED.httpAdmin.post('/performance-monitor/settings', (req, res) => {
        const { retentionDays, maxDbSizeMB } = req.body || {};
        if (Number.isFinite(Number(retentionDays))) store.retentionDays = Number(retentionDays);
        if (Number.isFinite(Number(maxDbSizeMB))) store.maxDbSizeMB = Number(maxDbSizeMB);
        res.json({ ok: true, retentionDays: store.retentionDays, maxDbSizeMB: store.maxDbSizeMB });
    });
}

module.exports = { registerRoutes };
