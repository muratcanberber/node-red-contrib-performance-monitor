'use strict';
const EventEmitter = require('events');

const SEVERITY = {
    cpu_spike:     'high',
    heap_growth:   'high',
    loop_block:    'critical',
    traffic_drop:  'critical',
    traffic_spike: 'medium',
    user_fixed:    'medium',
    user_statistical: 'medium'
};

class AnomalyDetector {
    constructor({ store, collector, RED }) {
        this._store = store;
        this._collector = collector;
        this._RED = RED;

        this._rules = [];
        this._ruleWindows = new Map();      // rule_id → number[] (recent values for duration check)
        this._cooldowns = new Map();        // key → { activeUntil }

        // Rolling buffer for statistical baseline: last 1800 samples per metric
        this._baseline = new Map();         // metric → number[]

        // Built-in pattern state
        this._heapWindow = [];              // { ts, value } for slope calculation (5-min window)
        this._trafficWindow = [];           // { ts, count } 5-min window for traffic anomalies
    }

    start() {
        this._onSample = (payload) => this._evaluate(payload);
        this._store.on('sample', this._onSample);

        this._loadRules();
        this._reloadTimer = setInterval(() => this._loadRules(), 60_000);
        if (this._reloadTimer.unref) this._reloadTimer.unref();

        if (this._RED && this._RED.events && this._RED.events.on) {
            this._onRulesChanged = () => this._loadRules();
            this._RED.events.on('rules:changed', this._onRulesChanged);
        }
    }

    stop() {
        if (this._onSample) this._store.off('sample', this._onSample);
        clearInterval(this._reloadTimer);
        if (this._RED && this._RED.events && this._onRulesChanged) {
            this._RED.events.off('rules:changed', this._onRulesChanged);
        }
    }

    _loadRules() {
        try {
            this._rules = this._store.getAlarmRules().filter(r => r.enabled);
        } catch (err) {
            if (this._RED && this._RED.log) this._RED.log.warn(`[perf-monitor] anomaly: rule load failed: ${err.message}`);
            this._rules = [];
        }
        // Remove rule windows for rules that no longer exist
        const activeIds = new Set(this._rules.map(r => r.id));
        for (const k of this._ruleWindows.keys()) {
            if (!activeIds.has(k)) this._ruleWindows.delete(k);
        }
    }

    _isInCooldown(key) {
        const cd = this._cooldowns.get(key);
        return cd && Date.now() < cd.activeUntil;
    }

    _setCooldown(key, durationMs) {
        const cooldownMs = Math.max(durationMs * 2, 60_000);
        this._cooldowns.set(key, { activeUntil: Date.now() + cooldownMs });
    }

    _fireAlert(alert) {
        // Persist
        try {
            this._store.insertEvent({ ts: alert.ts, kind: 'anomaly', detail: alert });
        } catch (err) {
            if (this._RED && this._RED.log) this._RED.log.warn(`[perf-monitor] anomaly: insertEvent failed: ${err.message}`);
        }

        // RED notification bar
        if (this._RED && this._RED.events) {
            try {
                this._RED.events.emit('runtime-event', {
                    id: 'perf-monitor:anomaly',
                    retain: false,
                    payload: { type: 'warning', text: alert.message }
                });
            } catch (_) {}
        }

        // Flow node output
        if (this._collector) {
            try {
                this._collector.emitAlarm(alert);
            } catch (_) {}
        }
    }

    _updateBaseline(metric, value) {
        if (!this._baseline.has(metric)) this._baseline.set(metric, []);
        const buf = this._baseline.get(metric);
        buf.push(value);
        if (buf.length > 1800) buf.shift();
    }

    _baselineStats(metric) {
        const buf = this._baseline.get(metric) || [];
        if (buf.length < 30) return null;
        const mean = buf.reduce((a, v) => a + v, 0) / buf.length;
        const variance = buf.reduce((a, v) => a + (v - mean) ** 2, 0) / buf.length;
        return { mean, std: Math.sqrt(variance), n: buf.length };
    }

    _evaluate({ ts, system, nodes = [] }) {
        // Update baselines
        for (const metric of ['proc_cpu_pct', 'proc_heap_used', 'event_loop_lag', 'sys_cpu_pct']) {
            if (system[metric] != null) this._updateBaseline(metric, system[metric]);
        }

        // ── User-defined alarm rules ─────────────────────────────────────
        for (const rule of this._rules) {
            // Skip builtin-disable rules (metric starts with 'builtin:')
            if (rule.metric.startsWith('builtin:')) continue;
            try {
                this._evaluateUserRule(rule, system, ts);
            } catch (err) {
                if (this._RED && this._RED.log) this._RED.log.warn(`[perf-monitor] anomaly: rule ${rule.id} eval error: ${err.message}`);
            }
        }

        // ── Built-in security patterns ────────────────────────────────────
        const builtinDisabled = new Set(
            this._store.getAlarmRules()
                .filter(r => r.metric.startsWith('builtin:') && r.enabled === 0)
                .map(r => r.metric.replace('builtin:', ''))
        );

        if (!builtinDisabled.has('cpu_spike'))    this._evalCpuSpike(system, ts);
        if (!builtinDisabled.has('heap_growth'))  this._evalHeapGrowth(system, ts);
        if (!builtinDisabled.has('loop_block'))   this._evalLoopBlock(system, ts);
        if (!builtinDisabled.has('traffic_drop') && !builtinDisabled.has('traffic_spike')) {
            this._evalTrafficAnomalies(system, nodes, ts);
        }
    }

    _evaluateUserRule(rule, system, ts) {
        const value = system[rule.metric];
        if (value == null) return;

        const pollInterval = 2000;
        const windowSize = Math.max(1, Math.ceil((rule.duration_s * 1000) / pollInterval));

        if (!this._ruleWindows.has(rule.id)) this._ruleWindows.set(rule.id, []);
        const window = this._ruleWindows.get(rule.id);

        let breaching;
        if (rule.mode === 'fixed') {
            breaching = value > rule.threshold;
        } else {
            // statistical
            const stats = this._baselineStats(rule.metric);
            if (!stats) {
                // fallback to fixed when baseline not yet established
                breaching = rule.threshold != null && value > rule.threshold;
            } else {
                breaching = value > stats.mean + rule.threshold * stats.std;
            }
        }

        window.push(breaching ? 1 : 0);
        if (window.length > windowSize) window.shift();

        if (window.length < windowSize) return;
        const allBreaching = window.every(v => v === 1);
        if (!allBreaching) return;

        const key = `rule:${rule.id}`;
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, rule.duration_s * 1000);

        const deployNearby = this._checkDeployNearby(ts);

        const alert = {
            ts,
            kind: 'anomaly',
            pattern: key,
            metric: rule.metric,
            value,
            threshold: rule.threshold,
            mode: rule.mode,
            durationMs: rule.duration_s * 1000,
            severity: rule.mode === 'fixed' ? SEVERITY.user_fixed : SEVERITY.user_statistical,
            message: `${rule.metric} ${value.toFixed(2)} sustained for ${rule.duration_s}s (threshold: ${rule.threshold}, mode: ${rule.mode}).`,
            deployNearby
        };
        this._fireAlert(alert);
    }

    _checkDeployNearby(ts) {
        try {
            const events = this._store.getEvents(ts - 5 * 60_000, ts + 5 * 60_000, ['deploy']);
            return events.length > 0;
        } catch (_) { return false; }
    }

    // Built-in: CPU spike ≥ 90% for 60s
    _evalCpuSpike(system, ts) {
        const threshold = 90, duration_s = 60;
        const windowSize = Math.ceil((duration_s * 1000) / 2000);
        if (!this._cpuWindow) this._cpuWindow = [];
        this._cpuWindow.push(system.proc_cpu_pct > threshold ? 1 : 0);
        if (this._cpuWindow.length > windowSize) this._cpuWindow.shift();
        if (this._cpuWindow.length < windowSize) return;
        if (!this._cpuWindow.every(v => v === 1)) return;

        const key = 'builtin:cpu_spike';
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, duration_s * 1000);
        this._fireAlert({
            ts, kind: 'anomaly', pattern: 'cpu_spike', metric: 'proc_cpu_pct',
            value: system.proc_cpu_pct, threshold,
            mode: 'fixed', durationMs: duration_s * 1000,
            severity: SEVERITY.cpu_spike,
            message: `Process CPU ${system.proc_cpu_pct.toFixed(1)}% sustained for ${duration_s}s (threshold: ${threshold}%). Possible crypto-mining.`,
            deployNearby: this._checkDeployNearby(ts)
        });
    }

    // Built-in: heap linear slope > 20 MB/min over 5-min window
    _evalHeapGrowth(system, ts) {
        const SLOPE_LIMIT_MB_PER_MIN = 20;
        const WINDOW_MS = 5 * 60_000;
        this._heapWindow.push({ ts, value: system.proc_heap_used });
        while (this._heapWindow.length > 0 && ts - this._heapWindow[0].ts > WINDOW_MS) {
            this._heapWindow.shift();
        }
        if (this._heapWindow.length < 10) return;

        const slope = this._linearSlopeMBPerMin(this._heapWindow);
        if (slope < SLOPE_LIMIT_MB_PER_MIN) return;

        const key = 'builtin:heap_growth';
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, WINDOW_MS);
        this._fireAlert({
            ts, kind: 'anomaly', pattern: 'heap_growth', metric: 'proc_heap_used',
            value: system.proc_heap_used, threshold: SLOPE_LIMIT_MB_PER_MIN,
            mode: 'fixed', durationMs: WINDOW_MS,
            severity: SEVERITY.heap_growth,
            message: `Heap growing at ${slope.toFixed(1)} MB/min over last 5 min (limit: ${SLOPE_LIMIT_MB_PER_MIN} MB/min). Possible memory leak.`,
            deployNearby: this._checkDeployNearby(ts)
        });
    }

    _linearSlopeMBPerMin(points) {
        const n = points.length;
        const t0 = points[0].ts;
        const xs = points.map(p => (p.ts - t0) / 60_000); // minutes
        const ys = points.map(p => p.value / 1e6);          // MB
        const meanX = xs.reduce((a, v) => a + v, 0) / n;
        const meanY = ys.reduce((a, v) => a + v, 0) / n;
        const num = xs.reduce((a, v, i) => a + (v - meanX) * (ys[i] - meanY), 0);
        const den = xs.reduce((a, v) => a + (v - meanX) ** 2, 0);
        return den === 0 ? 0 : num / den;
    }

    // Built-in: event loop lag > 500ms for 10s
    _evalLoopBlock(system, ts) {
        const threshold = 500, duration_s = 10;
        const windowSize = Math.ceil((duration_s * 1000) / 2000);
        if (!this._lagWindow) this._lagWindow = [];
        this._lagWindow.push(system.event_loop_lag > threshold ? 1 : 0);
        if (this._lagWindow.length > windowSize) this._lagWindow.shift();
        if (this._lagWindow.length < windowSize) return;
        if (!this._lagWindow.every(v => v === 1)) return;

        const key = 'builtin:loop_block';
        if (this._isInCooldown(key)) return;
        this._setCooldown(key, duration_s * 1000);
        this._fireAlert({
            ts, kind: 'anomaly', pattern: 'loop_block', metric: 'event_loop_lag',
            value: system.event_loop_lag, threshold,
            mode: 'fixed', durationMs: duration_s * 1000,
            severity: SEVERITY.loop_block,
            message: `Event loop blocked ${system.event_loop_lag.toFixed(0)}ms for ${duration_s}s (threshold: ${threshold}ms). Possible DoS.`,
            deployNearby: this._checkDeployNearby(ts)
        });
    }

    // Built-in: traffic drop (90% vs 5-min avg) and traffic spike (baseline + 5σ)
    _evalTrafficAnomalies(system, nodes, ts) {
        const totalMsgs = nodes.reduce((a, n) => a + (n.msg_count || 0), 0);
        const WINDOW_MS = 5 * 60_000;
        this._trafficWindow.push({ ts, count: totalMsgs });
        while (this._trafficWindow.length > 0 && ts - this._trafficWindow[0].ts > WINDOW_MS) {
            this._trafficWindow.shift();
        }
        if (this._trafficWindow.length < 5) return;

        const counts = this._trafficWindow.map(p => p.count);
        const avg = counts.reduce((a, v) => a + v, 0) / counts.length;
        const std = Math.sqrt(counts.reduce((a, v) => a + (v - avg) ** 2, 0) / counts.length);

        // Drop
        if (avg > 0 && totalMsgs < avg * 0.1) {
            const key = 'builtin:traffic_drop';
            if (!this._isInCooldown(key)) {
                this._setCooldown(key, 30_000);
                this._fireAlert({
                    ts, kind: 'anomaly', pattern: 'traffic_drop', metric: 'msg_count',
                    value: totalMsgs, threshold: avg * 0.1,
                    mode: 'fixed', durationMs: 30_000,
                    severity: SEVERITY.traffic_drop,
                    message: `Message throughput dropped to ${totalMsgs} (90% below 5-min avg ${avg.toFixed(0)}). Possible crash or kill signal.`,
                    deployNearby: this._checkDeployNearby(ts)
                });
            }
        }

        // Spike
        if (std > 0 && totalMsgs > avg + 5 * std) {
            const key = 'builtin:traffic_spike';
            if (!this._isInCooldown(key)) {
                this._setCooldown(key, 30_000);
                this._fireAlert({
                    ts, kind: 'anomaly', pattern: 'traffic_spike', metric: 'msg_count',
                    value: totalMsgs, threshold: avg + 5 * std,
                    mode: 'statistical', durationMs: 30_000,
                    severity: SEVERITY.traffic_spike,
                    message: `Message throughput ${totalMsgs} is baseline + 5σ (avg=${avg.toFixed(0)}, σ=${std.toFixed(0)}).`,
                    deployNearby: this._checkDeployNearby(ts)
                });
            }
        }
    }
}

module.exports = AnomalyDetector;
