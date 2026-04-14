const EventEmitter = require('events');
const os = require('os');
const fs = require('fs');
const { detectContainerEnvironment, readContainerMemoryUsage } = require('./container-detect');

class MetricsCollector extends EventEmitter {
    constructor({ RED, pollInterval = 2000 } = {}) {
        super();
        this.RED = RED;
        this.pollInterval = pollInterval;
        this._lastCpu = process.cpuUsage();
        this._lastCpuTs = process.hrtime.bigint();
        this._lastLoopCheck = process.hrtime.bigint();
        this._loopLag = 0;
        this._nodes = new Map();
        this._container = detectContainerEnvironment();

        this._startLoopLagProbe();
    }

    _startLoopLagProbe() {
        const intervalMs = 500;
        this._loopTimer = setInterval(() => {
            const now = process.hrtime.bigint();
            const diffMs = Number(now - this._lastLoopCheck) / 1e6;
            this._loopLag = Math.max(0, diffMs - intervalMs);
            this._lastLoopCheck = now;
        }, intervalMs);
        if (this._loopTimer.unref) this._loopTimer.unref();
    }

    sampleSystem() {
        const ts = Date.now();

        const cpu = process.cpuUsage();
        const now = process.hrtime.bigint();
        const elapsedMicros = Number(now - this._lastCpuTs) / 1000;
        const userDelta = cpu.user - this._lastCpu.user;
        const sysDelta = cpu.system - this._lastCpu.system;
        const procCpuPct = elapsedMicros > 0
            ? ((userDelta + sysDelta) / elapsedMicros) * 100
            : 0;
        this._lastCpu = cpu;
        this._lastCpuTs = now;

        const mem = process.memoryUsage();

        const cpus = os.cpus();
        let sysIdle = 0, sysTotal = 0;
        for (const c of cpus) {
            sysIdle  += c.times.idle;
            sysTotal += c.times.user + c.times.sys + c.times.idle + c.times.nice + c.times.irq;
        }
        const sysCpuPct = sysTotal > 0 ? ((sysTotal - sysIdle) / sysTotal) * 100 : 0;

        const sysMemTotal = this._container.memoryLimit || os.totalmem();
        let sysMemUsed;
        if (this._container.isContainerized) {
            const cg = readContainerMemoryUsage();
            sysMemUsed = (cg != null) ? cg : (os.totalmem() - os.freemem());
        } else {
            sysMemUsed = os.totalmem() - os.freemem();
        }

        let diskUsed = 0, diskTotal = 0;
        try {
            const stat = fs.statfsSync ? fs.statfsSync(process.cwd()) : null;
            if (stat) {
                diskTotal = stat.blocks * stat.bsize;
                diskUsed = (stat.blocks - stat.bfree) * stat.bsize;
            }
        } catch (_) {}

        return {
            ts,
            proc_cpu_pct: procCpuPct,
            proc_rss: mem.rss,
            proc_heap_used: mem.heapUsed,
            proc_heap_total: mem.heapTotal,
            event_loop_lag: this._loopLag,
            sys_cpu_pct: sysCpuPct,
            sys_mem_used: sysMemUsed,
            sys_mem_total: sysMemTotal,
            disk_used: diskUsed,
            disk_total: diskTotal,
            container: this._container.isContainerized ? 1 : 0
        };
    }

    attachHooks() {
        if (!this.RED || !this.RED.hooks) return;

        this.RED.hooks.add('preRoute', (sendEvents) => {
            try {
                const node = sendEvents && sendEvents.source && sendEvents.source.node;
                const msg = sendEvents && sendEvents.msg;
                if (!node || !msg) return;
                const rec = this._ensureNodeRec(node.id, node.type);
                rec.starts.set(msg._msgid, process.hrtime.bigint());
            } catch (_) {}
        });

        this.RED.hooks.add('postDeliver', (sendEvents) => {
            try {
                const node = sendEvents && sendEvents.source && sendEvents.source.node;
                const msg = sendEvents && sendEvents.msg;
                if (!node || !msg) return;
                const rec = this._ensureNodeRec(node.id, node.type);
                const start = rec.starts.get(msg._msgid);
                if (start !== undefined) {
                    const deltaMs = Number(process.hrtime.bigint() - start) / 1e6;
                    rec.count += 1;
                    rec.sumMs += deltaMs;
                    rec.starts.delete(msg._msgid);
                }
            } catch (_) {}
        });
    }

    _ensureNodeRec(id, type) {
        let rec = this._nodes.get(id);
        if (!rec) {
            rec = { type, count: 0, sumMs: 0, errors: 0, lastErrorTs: null, starts: new Map() };
            this._nodes.set(id, rec);
        } else {
            rec.type = type || rec.type;
        }
        return rec;
    }

    recordNodeError(nodeId, nodeType) {
        const rec = this._ensureNodeRec(nodeId, nodeType);
        rec.errors += 1;
        rec.lastErrorTs = Date.now();
    }

    drainNodes() {
        const out = [];
        for (const [id, rec] of this._nodes.entries()) {
            if (rec.count > 0 || rec.errors > 0) {
                out.push({
                    node_id: id,
                    node_type: rec.type,
                    msg_count: rec.count,
                    avg_process_ms: rec.count > 0 ? rec.sumMs / rec.count : 0,
                    error_count: rec.errors,
                    last_error_ts: rec.lastErrorTs
                });
            }
            rec.count = 0;
            rec.sumMs = 0;
            rec.errors = 0;
            rec.lastErrorTs = null;
            if (rec.starts.size > 1000) rec.starts.clear();
        }
        return out;
    }

    attachLifecycleListeners() {
        if (!this.RED || !this.RED.events) return;
        this.RED.events.on('flows:started', () => {
            this.emit('event', { ts: Date.now(), kind: 'deploy', detail: null });
        });
        this.RED.events.on('flows:stopped', () => {
            this.emit('event', { ts: Date.now(), kind: 'stop', detail: null });
        });
    }

    start(store) {
        this._store = store;
        this.attachHooks();
        this.attachLifecycleListeners();
        this.on('event', e => { try { store.insertEvent(e); } catch (_) {} });

        this._flushTimer = setInterval(() => this.tick(), this.pollInterval);
        if (this._flushTimer.unref) this._flushTimer.unref();
    }

    tick() {
        const tStart = Date.now();
        const system = this.sampleSystem();
        const nodes = this.drainNodes();
        try {
            this._store.flush({ system, nodes });
        } catch (err) {
            if (this.RED && this.RED.log) this.RED.log.warn(`[perf-monitor] flush failed: ${err.message}`);
        }
        const elapsed = Date.now() - tStart;
        if (elapsed > 500 && this.RED && this.RED.log) {
            this.RED.log.warn(`[perf-monitor] slow flush: ${elapsed}ms`);
        }
    }

    stop() {
        clearInterval(this._loopTimer);
        clearInterval(this._flushTimer);
    }
}

module.exports = MetricsCollector;
