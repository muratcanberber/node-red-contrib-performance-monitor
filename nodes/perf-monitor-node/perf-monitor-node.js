'use strict';

module.exports = function (RED) {
    const store = RED._store;
    const collector = RED._collector;

    function buildPayload(system, nodes, includeNodeStats) {
        const mem = process.memoryUsage();
        return {
            ts: system.ts,
            process: {
                cpu: system.proc_cpu_pct,
                memory: {
                    rss: system.proc_rss,
                    heapUsed: system.proc_heap_used,
                    heapTotal: system.proc_heap_total,
                    external: mem.external || 0,
                    arrayBuffers: mem.arrayBuffers || 0
                },
                eventLoopLag: system.event_loop_lag,
                pid: process.pid,
                uptime: process.uptime()
            },
            system: {
                cpu: system.sys_cpu_pct,
                memory: {
                    used: system.sys_mem_used,
                    total: system.sys_mem_total,
                    pct: system.sys_mem_total > 0 ? (system.sys_mem_used / system.sys_mem_total) * 100 : 0
                },
                disk: {
                    used: system.disk_used,
                    total: system.disk_total,
                    pct: system.disk_total > 0 ? (system.disk_used / system.disk_total) * 100 : 0
                }
            },
            nodes: includeNodeStats ? nodes.map(n => ({
                id: n.node_id,
                type: n.node_type,
                msgCount: n.msg_count,
                avgMs: n.avg_process_ms,
                errors: n.error_count
            })) : [],
            container: system.container === 1,
            source: 'perf-monitor'
        };
    }

    function PerfMonitorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const mode = config.mode || 'both';
        const includeNodeStats = config.includeNodeStats !== false;

        if (!store) {
            node.status({ fill: 'red', shape: 'ring', text: 'store unavailable' });
            return;
        }
        if (!collector) {
            node.status({ fill: 'red', shape: 'ring', text: 'collector unavailable' });
            return;
        }

        if (config.disableLogging) {
            store.setLoggingEnabled(false);
            if (RED.log) RED.log.warn('[perf-monitor] logging disabled by flow node — pipe metrics to external sink');
        }

        const statusOk = store.isDegraded()
            ? { fill: 'yellow', shape: 'dot', text: 'degraded store' }
            : { fill: 'green', shape: 'dot', text: 'running' };
        node.status(statusOk);

        function sendPayload(system, nodes) {
            node.send({
                topic: 'perf-monitor',
                payload: buildPayload(system, nodes, includeNodeStats)
            });
        }

        if (mode === 'interval' || mode === 'both') {
            const onSample = ({ system, nodes }) => sendPayload(system, nodes || []);
            store.on('sample', onSample);
            node.on('close', () => store.off('sample', onSample));
        }

        if (mode === 'inject' || mode === 'both') {
            node.on('input', (msg, send, done) => {
                const recent = store.getRecent(1);
                if (recent.length > 0) {
                    sendPayload(recent[0], []);
                } else if (collector) {
                    sendPayload(collector.sampleSystem(), []);
                } else {
                    node.status({ fill: 'red', shape: 'ring', text: 'no sample yet' });
                }
                if (done) done();
            });
        }

        const onAlarm = (payload) => {
            node.send({ topic: 'perf-monitor:alarm', payload });
        };
        collector.on('alarm', onAlarm);
        node.on('close', () => {
            collector.off('alarm', onAlarm);
            if (config.disableLogging) store.setLoggingEnabled(true);
        });
    }

    RED.nodes.registerType('perf-monitor', PerfMonitorNode);
};
