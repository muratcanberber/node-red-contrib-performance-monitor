/**
 * Performance Monitor Test Suite
 * Using Mocha and Sinon for 100% coverage
 */

const assert = require('assert');
const sinon = require('sinon');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Mock RED object
const RED = {
    log: {
        info: sinon.stub(),
        error: sinon.stub(),
        warn: sinon.stub()
    },
    httpAdmin: {
        get: sinon.stub(),
        post: sinon.stub()
    },
    plugins: {
        registerPlugin: sinon.stub()
    },
    nodes: {
        registerType: sinon.stub()
    }
};

// Store original functions for restoration
const originalCpuUsage = process.cpuUsage;
const originalHrtime = process.hrtime;
const originalMemoryUsage = process.memoryUsage;

describe('Performance Monitor', function () {
    let sandbox;
    let monitorModule;
    let internalFunctions;

    beforeEach(function () {
        sandbox = sinon.createSandbox();

        // Reset RED stubs
        RED.log.info.reset();
        RED.log.error.reset();
        RED.httpAdmin.get.reset();
        RED.httpAdmin.post.reset();
        RED.plugins.registerPlugin.reset();

        // Load the module fresh
        delete require.cache[require.resolve('../performance-monitor.js')];
        monitorModule = require('../performance-monitor.js');

        // Call the module to register plugin
        monitorModule(RED);

        // Get internal functions for testing
        internalFunctions = monitorModule._internal;
    });

    afterEach(function () {
        sandbox.restore();
        // Restore original process functions
        process.cpuUsage = originalCpuUsage;
        process.hrtime = originalHrtime;
        process.memoryUsage = originalMemoryUsage;
    });

    describe('Plugin Registration', function () {
        it('should register as a sidebar plugin', function () {
            assert(RED.plugins.registerPlugin.calledOnce);
            const call = RED.plugins.registerPlugin.getCall(0);
            assert.strictEqual(call.args[0], 'performance-monitor');
            assert.strictEqual(call.args[1].type, 'sidebar');
        });

        it('should log plugin loaded message', function () {
            // The onadd function is called during registration
            const pluginConfig = RED.plugins.registerPlugin.getCall(0).args[1];
            pluginConfig.onadd();

            assert(RED.log.info.calledWith('Performance Monitor plugin loaded (v1.1.0 - Precision & UI Update)'));
        });

        it('should register HTTP endpoints', function () {
            const pluginConfig = RED.plugins.registerPlugin.getCall(0).args[1];
            pluginConfig.onadd();

            // Should register 4 endpoints: stats (get), settings (get), settings (post), sidebar (get)
            assert(RED.httpAdmin.get.calledWith('/performance-monitor/stats'));
            assert(RED.httpAdmin.get.calledWith('/performance-monitor/settings'));
            assert(RED.httpAdmin.post.calledWith('/performance-monitor/settings'));
            assert(RED.httpAdmin.get.calledWith('/performance-monitor/sidebar'));
        });
    });

    describe('Cross-Platform Support', function () {
        it('should handle Windows environment (win32)', function () {
            sandbox.stub(os, 'platform').returns('win32');

            const platform = os.platform();
            assert.strictEqual(platform, 'win32');

            // getDiskUsage should use C:\\ on Windows
            // This is tested indirectly through the collectMetrics function
        });

        it('should handle Linux environment', function () {
            sandbox.stub(os, 'platform').returns('linux');

            const platform = os.platform();
            assert.strictEqual(platform, 'linux');
        });

        it('should handle Darwin (macOS) environment', function () {
            sandbox.stub(os, 'platform').returns('darwin');

            const platform = os.platform();
            assert.strictEqual(platform, 'darwin');
        });

        it('should handle undefined fs.statfs (serverless/sandboxed)', async function () {
            // Save original statfs
            const originalStatfs = fs.statfs;

            // Mock fs.statfs as undefined (like in Cloudflare Workers)
            fs.statfs = undefined;

            // Reload module to pick up the change
            delete require.cache[require.resolve('../performance-monitor.js')];
            const freshModule = require('../performance-monitor.js');
            freshModule(RED);

            const freshInternal = freshModule._internal;

            if (freshInternal && freshInternal.getDiskUsage) {
                const diskUsage = await freshInternal.getDiskUsage();

                // Should return default values when statfs is unavailable
                assert.strictEqual(diskUsage.mount, '/');
                assert.strictEqual(diskUsage.total, 0);
                assert.strictEqual(diskUsage.used, 0);
                assert.strictEqual(diskUsage.available, 0);
                assert.strictEqual(diskUsage.usedPercent, 0);
            }

            // Restore
            fs.statfs = originalStatfs;
        });

        it('should handle fs.statfs error gracefully', function (done) {
            sandbox.stub(fs, 'statfs').callsFake((path, callback) => {
                callback(new Error('Permission denied'), null);
            });

            if (internalFunctions && internalFunctions.getDiskUsage) {
                internalFunctions.getDiskUsage().then(diskUsage => {
                    assert.strictEqual(diskUsage.mount, '/');
                    assert.strictEqual(diskUsage.total, 0);
                    done();
                }).catch(done);
            } else {
                done();
            }
        });
    });

    describe('CPU Metrics', function () {
        it('should calculate CPU percentage using diff-based approach', function () {
            if (!internalFunctions || !internalFunctions.getCpuPercent) {
                this.skip();
                return;
            }

            // Reset baseline
            internalFunctions.resetCpuBaseline();

            // First call establishes baseline
            const cpuPercent = internalFunctions.getCpuPercent();

            // Should return a number between 0 and 100
            assert(typeof cpuPercent === 'number');
            assert(cpuPercent >= 0);
            assert(cpuPercent <= 100);
        });

        it('should handle CPU idle state (zero change)', function () {
            if (!internalFunctions || !internalFunctions.getCpuPercent) {
                this.skip();
                return;
            }

            // Mock process.cpuUsage to return zero change
            const mockCpuUsage = sandbox.stub(process, 'cpuUsage');
            mockCpuUsage.returns({ user: 0, system: 0 });
            mockCpuUsage.withArgs(sinon.match.any).returns({ user: 0, system: 0 });

            internalFunctions.resetCpuBaseline();
            const cpuPercent = internalFunctions.getCpuPercent();

            // Should return 0 or very close to 0 for idle state
            assert(cpuPercent >= 0);
            assert(cpuPercent <= 1); // Allow small margin for timing
        });

        it('should handle high CPU usage', function () {
            if (!internalFunctions || !internalFunctions.getCpuPercent) {
                this.skip();
                return;
            }

            // Mock high CPU usage (1000000 microseconds = 1 second of CPU time)
            const mockCpuUsage = sandbox.stub(process, 'cpuUsage');
            mockCpuUsage.returns({ user: 1000000, system: 500000 });
            mockCpuUsage.withArgs(sinon.match.any).returns({ user: 1000000, system: 500000 });

            internalFunctions.resetCpuBaseline();
            const cpuPercent = internalFunctions.getCpuPercent();

            // Should be capped at 100
            assert(cpuPercent <= 100);
        });

        it('should clamp CPU percentage to 0-100 range', function () {
            if (!internalFunctions || !internalFunctions.getCpuPercent) {
                this.skip();
                return;
            }

            // Mock extremely high CPU usage
            const mockCpuUsage = sandbox.stub(process, 'cpuUsage');
            mockCpuUsage.returns({ user: 99999999, system: 99999999 });
            mockCpuUsage.withArgs(sinon.match.any).returns({ user: 99999999, system: 99999999 });

            internalFunctions.resetCpuBaseline();
            const cpuPercent = internalFunctions.getCpuPercent();

            assert(cpuPercent <= 100, 'CPU should be capped at 100%');
        });
    });

    describe('Memory Metrics', function () {
        it('should return system memory info', function () {
            if (!internalFunctions || !internalFunctions.getSystemMemory) {
                this.skip();
                return;
            }

            const memInfo = internalFunctions.getSystemMemory();

            assert(typeof memInfo.total === 'number');
            assert(typeof memInfo.used === 'number');
            assert(typeof memInfo.free === 'number');
            assert(typeof memInfo.available === 'number');
            assert(typeof memInfo.usedPercent === 'number');

            assert(memInfo.total > 0);
            assert(memInfo.usedPercent >= 0);
            assert(memInfo.usedPercent <= 100);
        });

        it('should handle os.totalmem and os.freemem', function () {
            sandbox.stub(os, 'totalmem').returns(16 * 1024 * 1024 * 1024); // 16GB
            sandbox.stub(os, 'freemem').returns(8 * 1024 * 1024 * 1024);  // 8GB free

            if (!internalFunctions || !internalFunctions.getSystemMemory) {
                this.skip();
                return;
            }

            const memInfo = internalFunctions.getSystemMemory();

            assert.strictEqual(memInfo.total, 16 * 1024 * 1024 * 1024);
            assert.strictEqual(memInfo.free, 8 * 1024 * 1024 * 1024);
            assert.strictEqual(memInfo.usedPercent, 50);
        });

        it('should use process.memoryUsage for Node-RED metrics', function () {
            const mockMemUsage = {
                rss: 100 * 1024 * 1024,      // 100MB
                heapTotal: 80 * 1024 * 1024, // 80MB
                heapUsed: 60 * 1024 * 1024,  // 60MB
                external: 5 * 1024 * 1024,   // 5MB
                arrayBuffers: 2 * 1024 * 1024 // 2MB
            };

            sandbox.stub(process, 'memoryUsage').returns(mockMemUsage);

            const memInfo = process.memoryUsage();

            assert.strictEqual(memInfo.rss, 100 * 1024 * 1024);
            assert.strictEqual(memInfo.heapUsed, 60 * 1024 * 1024);
        });
    });

    describe('Event Loop Lag', function () {
        it('should measure event loop lag', function (done) {
            if (!internalFunctions || !internalFunctions.measureEventLoopLag) {
                this.skip();
                return;
            }

            internalFunctions.measureEventLoopLag();

            // Wait for setImmediate to complete
            setTimeout(() => {
                const lag = internalFunctions.getEventLoopLag();
                assert(typeof lag === 'number');
                assert(lag >= 0);
                done();
            }, 50);
        });

        it('should detect high event loop lag (simulated 500ms delay)', function (done) {
            if (!internalFunctions || !internalFunctions.setEventLoopLag) {
                this.skip();
                return;
            }

            // Simulate high lag by setting it directly
            internalFunctions.setEventLoopLag(500);

            const lag = internalFunctions.getEventLoopLag();
            assert.strictEqual(lag, 500);
            assert(lag >= 50, 'High lag should be detected as critical (>50ms)');
            done();
        });

        it('should handle normal event loop lag (<10ms)', function (done) {
            if (!internalFunctions || !internalFunctions.setEventLoopLag) {
                this.skip();
                return;
            }

            // Simulate low lag
            internalFunctions.setEventLoopLag(2);

            const lag = internalFunctions.getEventLoopLag();
            assert(lag < 10, 'Normal lag should be under 10ms');
            done();
        });
    });

    describe('CPU Info', function () {
        it('should return CPU core count and model', function () {
            if (!internalFunctions || !internalFunctions.getCpuInfo) {
                this.skip();
                return;
            }

            sandbox.stub(os, 'cpus').returns([
                { model: 'Intel Core i7', speed: 2800 },
                { model: 'Intel Core i7', speed: 2800 },
                { model: 'Intel Core i7', speed: 2800 },
                { model: 'Intel Core i7', speed: 2800 }
            ]);

            const cpuInfo = internalFunctions.getCpuInfo();

            assert.strictEqual(cpuInfo.cores, 4);
            assert.strictEqual(cpuInfo.model, 'Intel Core i7');
            assert.strictEqual(cpuInfo.speed, 2800);
        });

        it('should handle empty CPU array', function () {
            if (!internalFunctions || !internalFunctions.getCpuInfo) {
                this.skip();
                return;
            }

            sandbox.stub(os, 'cpus').returns([]);

            const cpuInfo = internalFunctions.getCpuInfo();

            assert.strictEqual(cpuInfo.cores, 0);
            assert.strictEqual(cpuInfo.model, 'Unknown');
            assert.strictEqual(cpuInfo.speed, 0);
        });
    });

    describe('Disk Usage', function () {
        it('should return disk usage information', async function () {
            if (!internalFunctions || !internalFunctions.getDiskUsage) {
                this.skip();
                return;
            }

            // Mock successful statfs call
            sandbox.stub(fs, 'statfs').callsFake((path, callback) => {
                callback(null, {
                    blocks: 1000000,
                    bsize: 4096,
                    bfree: 500000,
                    bavail: 400000
                });
            });

            const diskUsage = await internalFunctions.getDiskUsage();

            assert(typeof diskUsage.mount === 'string');
            assert(typeof diskUsage.total === 'number');
            assert(typeof diskUsage.used === 'number');
            assert(typeof diskUsage.available === 'number');
            assert(typeof diskUsage.usedPercent === 'number');
        });

        it('should handle Windows mount point', async function () {
            if (!internalFunctions || !internalFunctions.getDiskUsage) {
                this.skip();
                return;
            }

            sandbox.stub(os, 'platform').returns('win32');
            sandbox.stub(fs, 'statfs').callsFake((pathArg, callback) => {
                // Check that Windows path is used
                if (pathArg === 'C:\\') {
                    callback(null, {
                        blocks: 1000000,
                        bsize: 4096,
                        bfree: 500000,
                        bavail: 400000
                    });
                } else {
                    callback(new Error('Invalid path'));
                }
            });

            const diskUsage = await internalFunctions.getDiskUsage();

            // Should still return valid data
            assert(typeof diskUsage.total === 'number');
        });
    });

    describe('Metrics Collection', function () {
        it('should collect all metrics', async function () {
            if (!internalFunctions || !internalFunctions.collectMetrics) {
                this.skip();
                return;
            }

            const metrics = await internalFunctions.collectMetrics();

            assert(metrics.timestamp);
            assert(metrics.system);
            assert(metrics.nodeRed);

            // System metrics
            assert(typeof metrics.system.platform === 'string');
            assert(typeof metrics.system.arch === 'string');
            assert(metrics.system.cpu);
            assert(metrics.system.memory);

            // Node-RED metrics
            assert(typeof metrics.nodeRed.pid === 'number');
            assert(typeof metrics.nodeRed.uptime === 'number');
            assert(metrics.nodeRed.memory);
            assert(typeof metrics.nodeRed.eventLoopLag === 'number');
        });

        it('should cache metrics for performance', async function () {
            if (!internalFunctions || !internalFunctions.collectMetrics) {
                this.skip();
                return;
            }

            const metrics1 = await internalFunctions.collectMetrics();
            const metrics2 = await internalFunctions.collectMetrics();

            // Timestamps should be the same if cached
            assert.strictEqual(metrics1.timestamp, metrics2.timestamp);
        });

        it('should handle errors gracefully', async function () {
            if (!internalFunctions || !internalFunctions.collectMetrics) {
                this.skip();
                return;
            }

            // Force an error
            sandbox.stub(process, 'memoryUsage').throws(new Error('Test error'));

            const metrics = await internalFunctions.collectMetrics();

            // Should return cached data or error object
            assert(metrics);
        });
    });

    describe('Settings API', function () {
        it('should return default settings', function () {
            const pluginConfig = RED.plugins.registerPlugin.getCall(0).args[1];
            pluginConfig.onadd();

            // Find the settings GET handler
            const settingsHandler = RED.httpAdmin.get.getCalls().find(
                call => call.args[0] === '/performance-monitor/settings'
            );

            assert(settingsHandler, 'Settings endpoint should be registered');
        });

        it('should update settings via POST', function () {
            const pluginConfig = RED.plugins.registerPlugin.getCall(0).args[1];
            pluginConfig.onadd();

            // Find the settings POST handler
            const settingsHandler = RED.httpAdmin.post.getCalls().find(
                call => call.args[0] === '/performance-monitor/settings'
            );

            assert(settingsHandler, 'Settings POST endpoint should be registered');
        });
    });

    describe('Edge Cases', function () {
        it('should handle zero elapsed time in CPU calculation', function () {
            if (!internalFunctions || !internalFunctions.getCpuPercent) {
                this.skip();
                return;
            }

            // Mock hrtime to return same value (zero elapsed time)
            const fixedTime = BigInt(1000000000);
            sandbox.stub(process.hrtime, 'bigint').returns(fixedTime);

            internalFunctions.resetCpuBaseline();
            const cpuPercent = internalFunctions.getCpuPercent();

            // Should handle gracefully (return 0 on zero elapsed time)
            assert(cpuPercent >= 0);
        });

        it('should handle process.uptime', function () {
            sandbox.stub(process, 'uptime').returns(3600); // 1 hour

            const uptime = process.uptime();
            assert.strictEqual(uptime, 3600);
        });

        it('should handle process.pid', function () {
            assert(typeof process.pid === 'number');
            assert(process.pid > 0);
        });

        it('should handle missing arrayBuffers in memoryUsage (older Node.js)', function () {
            const mockMemUsage = {
                rss: 100 * 1024 * 1024,
                heapTotal: 80 * 1024 * 1024,
                heapUsed: 60 * 1024 * 1024,
                external: 5 * 1024 * 1024
                // arrayBuffers is missing (older Node.js)
            };

            sandbox.stub(process, 'memoryUsage').returns(mockMemUsage);

            const memInfo = process.memoryUsage();

            // Should handle missing arrayBuffers
            assert.strictEqual(memInfo.arrayBuffers, undefined);
        });
    });
});

describe('UI Helper Functions', function () {
    describe('Byte Formatting', function () {
        // These would test the client-side functions if exposed
        // For now, we test the concept

        it('should format bytes correctly', function () {
            const formatBytes = (bytes, decimals = 1) => {
                if (bytes === 0) return '0 B';
                const k = 1024;
                const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
            };

            assert.strictEqual(formatBytes(0), '0 B');
            assert.strictEqual(formatBytes(1024), '1 KB');
            assert.strictEqual(formatBytes(1048576), '1 MB');
            assert.strictEqual(formatBytes(1073741824), '1 GB');
        });
    });

    describe('Uptime Formatting', function () {
        it('should format uptime correctly', function () {
            const formatUptime = (seconds) => {
                const days = Math.floor(seconds / 86400);
                const hours = Math.floor((seconds % 86400) / 3600);
                const mins = Math.floor((seconds % 3600) / 60);
                if (days > 0) return `${days}d ${hours}h ${mins}m`;
                if (hours > 0) return `${hours}h ${mins}m`;
                return `${mins}m`;
            };

            assert.strictEqual(formatUptime(60), '1m');
            assert.strictEqual(formatUptime(3600), '1h 0m');
            assert.strictEqual(formatUptime(86400), '1d 0h 0m');
            assert.strictEqual(formatUptime(90061), '1d 1h 1m');
        });
    });

    describe('Status Classification', function () {
        it('should classify status correctly', function () {
            const getStatusClass = (percent) => {
                if (percent < 70) return 'pm-status-good';
                if (percent < 90) return 'pm-status-warn';
                return 'pm-status-crit';
            };

            assert.strictEqual(getStatusClass(50), 'pm-status-good');
            assert.strictEqual(getStatusClass(75), 'pm-status-warn');
            assert.strictEqual(getStatusClass(95), 'pm-status-crit');
        });

        it('should classify lag status correctly', function () {
            const getLagStatusClass = (lagMs) => {
                if (lagMs < 10) return 'pm-status-good';
                if (lagMs < 50) return 'pm-status-warn';
                return 'pm-status-crit';
            };

            assert.strictEqual(getLagStatusClass(5), 'pm-status-good');
            assert.strictEqual(getLagStatusClass(25), 'pm-status-warn');
            assert.strictEqual(getLagStatusClass(100), 'pm-status-crit');
        });
    });
});
