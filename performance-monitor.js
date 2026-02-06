/**
 * Node-RED Performance Monitor Plugin v1.1.0
 * Backend: Collects system metrics using native Node.js APIs
 * Zero native dependencies - works on Alpine, Windows, and Raspberry Pi
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

/**
 * Container/Cgroup Detection
 * Supports both cgroups v1 and v2 for Docker/Kubernetes environments
 */

// Cgroup paths
const CGROUP_V2_PATHS = {
    memoryMax: '/sys/fs/cgroup/memory.max',
    memoryCurrent: '/sys/fs/cgroup/memory.current',
    cpuMax: '/sys/fs/cgroup/cpu.max'
};

const CGROUP_V1_PATHS = {
    memoryLimit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    memoryUsage: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    cpuQuota: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
    cpuPeriod: '/sys/fs/cgroup/cpu/cpu.cfs_period_us'
};

// Cache for container detection (checked once at startup)
let containerInfo = null;

/**
 * Detect if running in a container with cgroup limits
 * @returns {Object} Container info with memory and CPU limits
 */
function detectContainerEnvironment() {
    if (containerInfo !== null) {
        return containerInfo;
    }

    containerInfo = {
        isContainerized: false,
        cgroupVersion: null,
        memoryLimit: null,
        cpuLimit: null
    };

    // Only check on Linux (containers use Linux cgroups)
    if (os.platform() !== 'linux') {
        return containerInfo;
    }

    try {
        // Try cgroups v2 first
        if (fs.existsSync(CGROUP_V2_PATHS.memoryMax)) {
            const memMax = fs.readFileSync(CGROUP_V2_PATHS.memoryMax, 'utf8').trim();

            // "max" means no limit, otherwise it's bytes
            if (memMax !== 'max') {
                const memLimit = parseInt(memMax, 10);
                // Check if limit is reasonable (less than host total and greater than 0)
                if (memLimit > 0 && memLimit < os.totalmem()) {
                    containerInfo.isContainerized = true;
                    containerInfo.cgroupVersion = 2;
                    containerInfo.memoryLimit = memLimit;
                }
            }

            // Check CPU limit
            if (fs.existsSync(CGROUP_V2_PATHS.cpuMax)) {
                const cpuMax = fs.readFileSync(CGROUP_V2_PATHS.cpuMax, 'utf8').trim();
                // Format: "$QUOTA $PERIOD" or "max $PERIOD"
                const parts = cpuMax.split(' ');
                if (parts[0] !== 'max' && parts.length === 2) {
                    const quota = parseInt(parts[0], 10);
                    const period = parseInt(parts[1], 10);
                    if (quota > 0 && period > 0) {
                        containerInfo.cpuLimit = quota / period;
                        containerInfo.isContainerized = true;
                    }
                }
            }
        }
        // Try cgroups v1 if v2 didn't work
        else if (fs.existsSync(CGROUP_V1_PATHS.memoryLimit)) {
            const memLimit = parseInt(fs.readFileSync(CGROUP_V1_PATHS.memoryLimit, 'utf8').trim(), 10);

            // Very large values (close to max int64) mean no limit
            const MAX_MEMORY_LIMIT = 9223372036854771712; // Common "no limit" value
            if (memLimit > 0 && memLimit < MAX_MEMORY_LIMIT && memLimit < os.totalmem()) {
                containerInfo.isContainerized = true;
                containerInfo.cgroupVersion = 1;
                containerInfo.memoryLimit = memLimit;
            }

            // Check CPU limit
            if (fs.existsSync(CGROUP_V1_PATHS.cpuQuota) && fs.existsSync(CGROUP_V1_PATHS.cpuPeriod)) {
                const quota = parseInt(fs.readFileSync(CGROUP_V1_PATHS.cpuQuota, 'utf8').trim(), 10);
                const period = parseInt(fs.readFileSync(CGROUP_V1_PATHS.cpuPeriod, 'utf8').trim(), 10);

                // -1 quota means no limit
                if (quota > 0 && period > 0) {
                    containerInfo.cpuLimit = quota / period;
                    containerInfo.isContainerized = true;
                }
            }
        }

        // Additional container detection: check for .dockerenv or kubernetes service account
        if (!containerInfo.isContainerized) {
            if (fs.existsSync('/.dockerenv') || fs.existsSync('/var/run/secrets/kubernetes.io')) {
                containerInfo.isContainerized = true;
            }
        }
    } catch (e) {
        // Ignore errors, use host metrics
    }

    return containerInfo;
}

/**
 * Get container memory info if available
 * @returns {Object|null} Container memory limits or null
 */
function getContainerMemory() {
    const info = detectContainerEnvironment();

    if (!info.isContainerized || !info.memoryLimit) {
        return null;
    }

    try {
        let currentUsage = 0;

        if (info.cgroupVersion === 2 && fs.existsSync(CGROUP_V2_PATHS.memoryCurrent)) {
            currentUsage = parseInt(fs.readFileSync(CGROUP_V2_PATHS.memoryCurrent, 'utf8').trim(), 10);
        } else if (info.cgroupVersion === 1 && fs.existsSync(CGROUP_V1_PATHS.memoryUsage)) {
            currentUsage = parseInt(fs.readFileSync(CGROUP_V1_PATHS.memoryUsage, 'utf8').trim(), 10);
        }

        return {
            total: info.memoryLimit,
            used: currentUsage,
            free: Math.max(0, info.memoryLimit - currentUsage),
            available: Math.max(0, info.memoryLimit - currentUsage),
            usedPercent: Math.round((currentUsage / info.memoryLimit) * 1000) / 10
        };
    } catch (e) {
        return null;
    }
}

/**
 * Get container CPU core limit if available
 * @returns {number|null} Effective CPU cores or null
 */
function getContainerCpuLimit() {
    const info = detectContainerEnvironment();
    return info.cpuLimit || null;
}

module.exports = function (RED) {
    // Configuration settings
    let settings = {
        refreshInterval: 2000,
        paneFontSize: 12,
        paneFontFamily: 'Helvetica Neue',
        hudSize: 'Normal',
        hudTheme: 'classic',
        hideHud: false
    };

    // CPU Usage Tracking (diff-based)
    let lastCpuUsage = process.cpuUsage();
    let lastCpuTime = process.hrtime.bigint();
    let lastCpuTimes = null;

    // Event Loop Lag Tracking
    let eventLoopLag = 0;
    let lagMeasureTimer = null;

    // Metrics cache
    let metricsCache = {
        data: null,
        timestamp: 0
    };

    /**
     * Calculate CPU usage percentage using diff-based process.cpuUsage()
     * @returns {number} CPU percentage (0-100)
     */
    function getCpuPercent() {
        const currentCpuUsage = process.cpuUsage(lastCpuUsage);
        const currentTime = process.hrtime.bigint();

        // Calculate elapsed time in milliseconds
        const elapsedMs = Number(currentTime - lastCpuTime) / 1e6;

        if (elapsedMs <= 0) {
            return 0;
        }

        // CPU usage is in microseconds, convert to percentage
        // (user + system) microseconds / (elapsed time in microseconds) * 100
        const totalCpuMicros = currentCpuUsage.user + currentCpuUsage.system;
        const cpuPercent = (totalCpuMicros / 1000) / elapsedMs * 100;

        // Update baseline for next calculation
        lastCpuUsage = process.cpuUsage();
        lastCpuTime = process.hrtime.bigint();

        // Clamp to 0-100 range
        return Math.min(Math.max(cpuPercent, 0), 100);
    }

    /**
     * Measure event loop lag using setImmediate
     */
    function measureEventLoopLag() {
        const start = process.hrtime.bigint();
        setImmediate(() => {
            const elapsed = process.hrtime.bigint() - start;
            eventLoopLag = Number(elapsed) / 1e6; // Convert to milliseconds
        });
    }

    /**
     * Start event loop lag measurement interval
     */
    function startLagMeasurement() {
        if (lagMeasureTimer) {
            clearInterval(lagMeasureTimer);
        }
        lagMeasureTimer = setInterval(measureEventLoopLag, 1000);
        measureEventLoopLag(); // Initial measurement
    }

    /**
     * Get system memory info using platform-specific methods for accuracy
     * In containers, uses cgroup limits instead of host memory
     * @returns {Promise<Object>} System memory information
     */
    async function getSystemMemory() {
        // Check for container memory limits first
        const containerMem = getContainerMemory();
        if (containerMem) {
            return containerMem;
        }

        // Fall back to host memory detection
        const totalMem = os.totalmem();
        let freeMem = os.freemem(); // Default fallback
        let availableMem = freeMem;

        try {
            if (os.platform() === 'linux') {
                try {
                    const info = fs.readFileSync('/proc/meminfo', 'utf8');
                    const match = info.match(/MemAvailable:\s+(\d+)\s+kB/);
                    if (match) {
                        availableMem = parseInt(match[1], 10) * 1024;
                        freeMem = availableMem;
                    }
                } catch (e) { /* ignore */ }
            }
            else if (os.platform() === 'darwin') {
                try {
                    const { stdout } = await execAsync('vm_stat');
                    const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
                    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

                    const freePages = parseInt((stdout.match(/Pages free:\s+(\d+)\./) || [0, 0])[1], 10);
                    const inactivePages = parseInt((stdout.match(/Pages inactive:\s+(\d+)\./) || [0, 0])[1], 10);
                    const speculativePages = parseInt((stdout.match(/Pages speculative:\s+(\d+)\./) || [0, 0])[1], 10);

                    availableMem = (freePages + inactivePages + speculativePages) * pageSize;
                    freeMem = availableMem;
                } catch (e) { /* ignore */ }
            }
        } catch (error) {
            // retain fallback
        }

        const usedMem = Math.max(0, totalMem - freeMem);

        return {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            available: freeMem,
            usedPercent: Math.round((usedMem / totalMem) * 1000) / 10
        };
    }

    /**
     * Get disk usage (cross-platform, graceful fallback)
     * @returns {Promise<Object>} Disk information
     */
    async function getDiskUsage() {
        const defaultDisk = {
            mount: '/',
            total: 0,
            used: 0,
            available: 0,
            usedPercent: 0
        };

        // Check if fs.statfs is available (Node.js 18.15+)
        if (typeof fs.statfs !== 'function') {
            return defaultDisk;
        }

        return new Promise((resolve) => {
            const mountPoint = os.platform() === 'win32' ? 'C:\\' : '/';

            fs.statfs(mountPoint, (err, stats) => {
                if (err || !stats) {
                    resolve(defaultDisk);
                    return;
                }

                const total = stats.blocks * stats.bsize;
                const free = stats.bfree * stats.bsize;
                const available = stats.bavail * stats.bsize;
                const used = total - free;

                resolve({
                    mount: mountPoint,
                    total: total,
                    used: used,
                    free: available,
                    available: available,
                    usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0
                });
            });
        });
    }

    /**
     * Get CPU information
     * In containers, includes effective cores based on CPU limit
     * @returns {Object} CPU info
     */
    function getCpuInfo() {
        const cpus = os.cpus();
        const containerCpuLimit = getContainerCpuLimit();

        return {
            cores: cpus.length,
            effectiveCores: containerCpuLimit || cpus.length,
            model: cpus.length > 0 ? cpus[0].model : 'Unknown',
            speed: cpus.length > 0 ? cpus[0].speed : 0
        };
    }

    /**
     * Get System CPU usage (cross-platform diff-based)
     * @returns {number} System CPU percentage (0-100)
     */
    function getSystemCpuUsage() {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;

        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });

        let percentage = 0;

        if (lastCpuTimes) {
            const idleDifference = totalIdle - lastCpuTimes.idle;
            const totalDifference = totalTick - lastCpuTimes.total;

            if (totalDifference > 0) {
                percentage = 100 - (100 * idleDifference / totalDifference);
            }
        }

        lastCpuTimes = {
            idle: totalIdle,
            total: totalTick
        };

        return Math.max(0, Math.min(percentage, 100)); // Clamp 0-100
    }

    /**
     * Collect all metrics
     * @returns {Promise<Object>} All performance metrics
     */
    async function collectMetrics() {
        const now = Date.now();

        // Return cached data if still valid (half of refresh interval)
        if (metricsCache.data && (now - metricsCache.timestamp) < (settings.refreshInterval / 2)) {
            return metricsCache.data;
        }

        try {
            // Get process memory usage (native Node.js API)
            const memoryUsage = process.memoryUsage();

            // Get system memory
            const systemMemory = await getSystemMemory();

            // Get System CPU


            // Get CPU percentage (diff-based)
            const cpuPercent = getCpuPercent();

            // Get CPU info
            const cpuInfo = getCpuInfo();

            // Get disk usage
            const diskUsage = await getDiskUsage();

            // Get System CPU
            const systemCpuPercent = getSystemCpuUsage();

            // Get container info
            const containerEnv = detectContainerEnvironment();

            const metrics = {
                timestamp: now,
                isContainerized: containerEnv.isContainerized,
                system: {
                    platform: os.platform(),
                    arch: os.arch(),
                    nodeVersion: process.version,
                    cpu: {
                        percent: Math.round(systemCpuPercent * 10) / 10,
                        cores: cpuInfo.cores,
                        effectiveCores: cpuInfo.effectiveCores,
                        model: cpuInfo.model,
                        speed: cpuInfo.speed
                    },
                    memory: systemMemory,
                    disk: diskUsage,
                    uptime: os.uptime()
                },
                nodeRed: {
                    pid: process.pid,
                    uptime: process.uptime(),
                    cpu: Math.round(cpuPercent * 10) / 10,
                    memory: {
                        rss: memoryUsage.rss,
                        heapTotal: memoryUsage.heapTotal,
                        heapUsed: memoryUsage.heapUsed,
                        external: memoryUsage.external,
                        arrayBuffers: memoryUsage.arrayBuffers || 0,
                        percentOfSystem: (memoryUsage.rss / systemMemory.total) * 100
                    },
                    eventLoopLag: Math.round(eventLoopLag * 100) / 100
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
            RED.log.info('Performance Monitor plugin loaded (v1.1.0 - Precision & UI Update)');

            // Start event loop lag measurement
            startLagMeasurement();

            // API: Get Stats
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
                if (req.body.refreshInterval !== undefined) {
                    settings.refreshInterval = parseInt(req.body.refreshInterval) || 2000;
                }
                if (req.body.paneFontSize !== undefined) {
                    settings.paneFontSize = parseInt(req.body.paneFontSize) || 12;
                }
                if (req.body.paneFontFamily !== undefined) {
                    settings.paneFontFamily = req.body.paneFontFamily || 'Helvetica Neue';
                }
                if (req.body.hudSize !== undefined) {
                    settings.hudSize = req.body.hudSize || 'Normal';
                }
                if (req.body.hudTheme !== undefined) {
                    settings.hudTheme = req.body.hudTheme || 'classic';
                }
                if (req.body.hideHud !== undefined) {
                    settings.hideHud = !!req.body.hideHud;
                }
                res.json(settings);
            });

            // Serve the sidebar HTML
            const sidebarHtml = fs.readFileSync(
                path.join(__dirname, 'performance-monitor.html'),
                'utf8'
            );

            RED.httpAdmin.get('/performance-monitor/sidebar', function (req, res) {
                res.send(sidebarHtml);
            });
        }
    });

    // Export for testing
    if (typeof module !== 'undefined' && module.exports) {
        module.exports._internal = {
            getCpuPercent,
            measureEventLoopLag,
            getSystemMemory,
            getDiskUsage,
            getCpuInfo,
            collectMetrics,
            getEventLoopLag: () => eventLoopLag,
            setEventLoopLag: (val) => { eventLoopLag = val; },
            stopLagMeasurement: () => {
                if (lagMeasureTimer) clearInterval(lagMeasureTimer);
            },
            resetCpuBaseline: () => {
                lastCpuUsage = process.cpuUsage();
                lastCpuTime = process.hrtime.bigint();
            },
            // Container detection functions for testing
            resetContainerInfo: () => { containerInfo = null; }
        };
    }
};
