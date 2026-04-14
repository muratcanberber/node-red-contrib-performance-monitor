const path = require('path');
const MetricsStore = require('./lib/metrics-store');
const MetricsCollector = require('./lib/metrics-collector');
const { registerRoutes } = require('./lib/http-routes');

module.exports = function (RED) {
    const settings = (RED.settings && RED.settings.performanceMonitor) || {};
    const pollInterval = settings.pollInterval || 2000;
    const retentionDays = settings.retentionDays || 7;
    const maxDbSizeMB = settings.maxDbSizeMB || 500;

    const userDir = (RED.settings && RED.settings.userDir) || process.cwd();
    const dbPath = path.join(userDir, 'performance-monitor.db');

    const store = new MetricsStore({ dbPath, retentionDays, maxDbSizeMB });
    store.openOrDegrade();
    if (store.isDegraded()) {
        RED.log.warn('[perf-monitor] DB unavailable — running in in-memory mode');
    }

    const collector = new MetricsCollector({ RED, pollInterval });
    collector.start(store);

    registerRoutes({ RED, store, collector });

    const retentionTimer = setInterval(() => {
        try { store.runRetention(); } catch (_) {}
    }, 60 * 60 * 1000);
    if (retentionTimer.unref) retentionTimer.unref();

    RED.plugins.registerPlugin('performance-monitor', {
        type: 'performance-monitor',
        onadd() { RED.log.info('[perf-monitor] plugin loaded'); }
    });

    if (RED.events && RED.events.on) {
        RED.events.on('runtime-event', (ev) => {
            if (ev && ev.id === 'shutdown') {
                clearInterval(retentionTimer);
                collector.stop();
                store.close();
            }
        });
    }

    module.exports._internal = { store, collector };
};
