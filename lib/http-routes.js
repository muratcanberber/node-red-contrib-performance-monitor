const os = require('os');
const path = require('path');

function registerRoutes({ RED, store, collector }) {
    // Valid metrics set for alarm rules validation
    const VALID_METRICS = new Set([
        'proc_cpu_pct', 'proc_rss', 'proc_heap_used', 'proc_heap_total',
        'event_loop_lag', 'sys_cpu_pct', 'sys_mem_used', 'sys_mem_total',
        'disk_used', 'disk_total'
    ]);
    // Legacy /stats endpoint — returns the nested shape the sidebar UI expects
    RED.httpAdmin.get('/performance-monitor/stats', (req, res) => {
        if (!collector) return res.status(503).json({ error: 'collector unavailable' });
        const s = collector.sampleSystem();
        const cpus = os.cpus();
        const sysPct = s.sys_mem_total > 0 ? (s.sys_mem_used / s.sys_mem_total) * 100 : 0;
        const diskPct = s.disk_total > 0 ? Math.round((s.disk_used / s.disk_total) * 100) : 0;
        const mem = process.memoryUsage();
        res.json({
            nodeRed: {
                cpu: s.proc_cpu_pct,
                memory: {
                    rss: s.proc_rss,
                    heapUsed: s.proc_heap_used,
                    heapTotal: s.proc_heap_total,
                    external: mem.external || 0,
                    arrayBuffers: mem.arrayBuffers || 0
                },
                eventLoopLag: s.event_loop_lag,
                pid: process.pid,
                uptime: process.uptime()
            },
            system: {
                cpu: {
                    percent: s.sys_cpu_pct,
                    cores: cpus.length,
                    model: cpus[0] ? cpus[0].model : 'Unknown'
                },
                memory: {
                    total: s.sys_mem_total,
                    used: s.sys_mem_used,
                    free: s.sys_mem_total - s.sys_mem_used,
                    usedPercent: sysPct
                },
                disk: {
                    total: s.disk_total,
                    used: s.disk_used,
                    free: s.disk_total - s.disk_used,
                    usedPercent: diskPct,
                    mount: '/'
                },
                platform: os.platform(),
                arch: os.arch(),
                nodeVersion: process.version,
                uptime: os.uptime(),
                hostname: os.hostname()
            }
        });
    });

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

    // Report page route — serves HTML file from disk
    const reportPagePath = path.join(__dirname, 'report-page.html');
    RED.httpAdmin.get('/performance-monitor/report', (req, res) => {
        res.type('html').sendFile(reportPagePath);
    });

    // Alarm rules CRUD endpoints
    RED.httpAdmin.get('/performance-monitor/alarm-rules', (req, res) => {
        res.json(store.getAlarmRules());
    });

    RED.httpAdmin.post('/performance-monitor/alarm-rules', (req, res) => {
        const { metric, mode, threshold, duration_s, enabled = 1 } = req.body || {};
        if (!metric || !VALID_METRICS.has(metric)) {
            return res.status(400).json({ error: 'invalid metric' });
        }
        if (!mode || !['fixed', 'statistical'].includes(mode)) {
            return res.status(400).json({ error: 'invalid mode' });
        }
        if (typeof duration_s !== 'number' || duration_s < 1) {
            return res.status(400).json({ error: 'duration_s must be positive number' });
        }
        if (threshold == null || !Number.isFinite(Number(threshold))) {
            return res.status(400).json({ error: 'threshold must be a finite number' });
        }
        try {
            const rule = store.insertAlarmRule({ metric, mode, threshold, duration_s, enabled });
            if (RED.events) RED.events.emit('rules:changed');
            res.status(201).json(rule);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    RED.httpAdmin.put('/performance-monitor/alarm-rules/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'invalid id' });
        if ('threshold' in (req.body || {}) && (req.body.threshold == null || !Number.isFinite(Number(req.body.threshold)))) {
            return res.status(400).json({ error: 'threshold must be a finite number' });
        }
        try {
            const rule = store.updateAlarmRule(id, req.body || {});
            if (!rule) return res.status(404).json({ error: 'rule not found' });
            if (RED.events) RED.events.emit('rules:changed');
            res.json(rule);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    RED.httpAdmin.delete('/performance-monitor/alarm-rules/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'invalid id' });
        try {
            store.deleteAlarmRule(id);
            if (RED.events) RED.events.emit('rules:changed');
            res.status(204).send('');
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { registerRoutes };
