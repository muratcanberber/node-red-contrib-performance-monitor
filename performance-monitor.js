/**
 * Node-RED Performance Monitor Plugin
 * Backend: Collects system metrics and exposes API endpoint
 */

const si = require('systeminformation');

module.exports = function (RED) {
    // Cache for metrics to avoid excessive system calls
    let settings = {
        refreshInterval: 2000
    };

    let metricsCache = {
        data: null,
        timestamp: 0
    };

    // Helper to calculate CPU percentage for a single PID
    // Returns promise resolving to percent number
    async function getPidCpu(pid) {
        try {
            const stats = await si.procStats();
            // This is a simplification. For accurate per-process CPU over time, 
            // we'd need to diff cpu time between intervals.
            // fallback to si.processes() which includes %cpu
            return null;
        } catch (e) { return 0; }
    }

    // Function to collect all system metrics
    async function collectMetrics() {
        const now = Date.now();

        // Return cached data if still valid (half of refresh interval)
        if (metricsCache.data && (now - metricsCache.timestamp) < (settings.refreshInterval / 2)) {
            return metricsCache.data;
        }

        try {
            // Collect all metrics in parallel
            const [
                cpuLoad,
                mem,
                fsSize,
                diskIO,
                networkStats,
                currentProcesses
            ] = await Promise.all([
                si.currentLoad(),
                si.mem(),
                si.fsSize(),
                si.disksIO(),
                si.networkStats(),
                si.processes()
            ]);

            // Find Node-RED process info
            // Looking for process that matches current PID
            const myPid = process.pid;
            const nodeRedProcess = currentProcesses.list.find(p => p.pid === myPid) || {};

            // Calculate primary disk usage
            const primaryDisk = fsSize.find(fs => fs.mount === '/') || fsSize[0] || {};

            // Calculate network totals
            const networkTotals = networkStats.reduce((acc, net) => {
                acc.rx_bytes += net.rx_bytes || 0;
                acc.tx_bytes += net.tx_bytes || 0;
                acc.rx_sec += net.rx_sec || 0;
                acc.tx_sec += net.tx_sec || 0;
                return acc;
            }, { rx_bytes: 0, tx_bytes: 0, rx_sec: 0, tx_sec: 0 });

            // Node-RED Memory Usage
            const memoryUsage = process.memoryUsage(); // Robust Node.js API

            const metrics = {
                timestamp: now,
                system: {
                    cpu: Math.round(cpuLoad.currentLoad * 10) / 10,
                    memory: {
                        total: mem.total,
                        used: mem.used,
                        free: mem.free,
                        available: mem.available,
                        usedPercent: Math.round((mem.used / mem.total) * 1000) / 10
                    },
                    disk: {
                        mount: primaryDisk.mount || '/',
                        total: primaryDisk.size || 0,
                        used: primaryDisk.used || 0,
                        available: primaryDisk.available || 0,
                        usedPercent: primaryDisk.use || 0
                    }
                },
                nodeRed: {
                    pid: myPid,
                    uptime: process.uptime(),
                    cpu: nodeRedProcess.cpu || 0, // % of one core
                    memory: {
                        rss: memoryUsage.rss,
                        heapTotal: memoryUsage.heapTotal,
                        heapUsed: memoryUsage.heapUsed,
                        external: memoryUsage.external,
                        percentOfSystem: (memoryUsage.rss / mem.total) * 100 // % of total system RAM
                    }
                },
                io: {
                    disk: {
                        read: diskIO ? diskIO.rIO_sec || 0 : 0,
                        write: diskIO ? diskIO.wIO_sec || 0 : 0
                    },
                    network: {
                        rx_sec: Math.round(networkTotals.rx_sec),
                        tx_sec: Math.round(networkTotals.tx_sec),
                        rx_total: networkTotals.rx_bytes,
                        tx_total: networkTotals.tx_bytes
                    }
                }
            };

            // Update cache
            metricsCache = {
                data: metrics,
                timestamp: now
            };

            return metrics;
        } catch (error) {
            RED.log.error('Performance Monitor: Error collecting metrics - ' + error.message);
            return metricsCache.data || { error: error.message };
        }
    }

    // Register the plugin
    RED.plugins.registerPlugin('performance-monitor', {
        type: 'sidebar',

        onadd: function () {
            RED.log.info('Performance Monitor plugin loaded (V2)');

            // API: Stats
            RED.httpAdmin.get('/performance-monitor/stats', async function (req, res) {
                try {
                    const metrics = await collectMetrics();
                    res.json(metrics);
                } catch (error) {
                    res.status(500).json({ error: error.message });
                }
            });

            // API: Get Settings
            RED.httpAdmin.get('/performance-monitor/settings', function (req, res) {
                res.json(settings);
            });

            // API: Set Settings
            RED.httpAdmin.post('/performance-monitor/settings', function (req, res) {
                if (req.body.refreshInterval) {
                    settings.refreshInterval = parseInt(req.body.refreshInterval);
                }
                res.json(settings);
            });

            // Serve the sidebar HTML
            const path = require('path');
            const fs = require('fs');
            const sidebarHtml = fs.readFileSync(
                path.join(__dirname, 'performance-monitor.html'),
                'utf8'
            );

            RED.httpAdmin.get('/performance-monitor/sidebar', function (req, res) {
                res.send(sidebarHtml);
            });
        }
    });
};
