const EventEmitter = require('events');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

class MetricsStore extends EventEmitter {
    constructor({ dbPath, retentionDays = 7, maxDbSizeMB = 500 } = {}) {
        super();
        this.dbPath = dbPath;
        this.retentionDays = retentionDays;
        this.maxDbSizeMB = maxDbSizeMB;
        this._db = null;
        this._stmt = {};
        this._degraded = false;
        this._memoryBuffer = [];
        this._loggingEnabled = true;
    }

    open() {
        this._db = new Database(this.dbPath);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('synchronous = NORMAL');
        this._db.pragma('auto_vacuum = INCREMENTAL');
        runMigrations(this._db);
        this._prepare();
    }

    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }

    _prepare() {
        this._stmt.insertSample = this._db.prepare(`
            INSERT INTO samples
            (ts, proc_cpu_pct, proc_rss, proc_heap_used, proc_heap_total,
             event_loop_lag, sys_cpu_pct, sys_mem_used, sys_mem_total,
             disk_used, disk_total, container)
            VALUES
            (@ts, @proc_cpu_pct, @proc_rss, @proc_heap_used, @proc_heap_total,
             @event_loop_lag, @sys_cpu_pct, @sys_mem_used, @sys_mem_total,
             @disk_used, @disk_total, @container)
        `);
        this._stmt.insertNodeSample = this._db.prepare(`
            INSERT INTO node_samples
            (ts, node_id, node_type, msg_count, avg_process_ms, error_count, last_error_ts)
            VALUES
            (@ts, @node_id, @node_type, @msg_count, @avg_process_ms, @error_count, @last_error_ts)
        `);
        this._stmt.recentSamples = this._db.prepare(`
            SELECT * FROM samples ORDER BY ts DESC LIMIT ?
        `);
        this._stmt.rangeRaw = this._db.prepare(`
            SELECT * FROM samples WHERE ts BETWEEN ? AND ? ORDER BY ts ASC
        `);
        this._stmt.nodeStats = this._db.prepare(`
            SELECT * FROM node_samples
            WHERE node_id = ? AND ts BETWEEN ? AND ?
            ORDER BY ts ASC
        `);
        this._stmt.events = this._db.prepare(`
            SELECT * FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts ASC
        `);
        this._stmt.getAlarmRules = this._db.prepare('SELECT * FROM alarm_rules ORDER BY id');
        this._stmt.insertAlarmRule = this._db.prepare(
            'INSERT INTO alarm_rules (metric, mode, threshold, duration_s, enabled, created_at, updated_at) VALUES (@metric, @mode, @threshold, @duration_s, @enabled, @created_at, @updated_at)'
        );
        this._stmt.getAlarmRuleById = this._db.prepare('SELECT * FROM alarm_rules WHERE id = ?');
        this._stmt.deleteAlarmRule = this._db.prepare('DELETE FROM alarm_rules WHERE id = ?');
    }

    openOrDegrade() {
        try {
            this.open();
        } catch (err) {
            this._degraded = true;
            this._memoryBuffer = [];
            this.emit('store:degraded', { error: err.message });
        }
    }

    isDegraded() { return this._degraded; }

    setLoggingEnabled(enabled) {
        this._loggingEnabled = !!enabled;
    }

    getAlarmRules() {
        if (this._degraded || !this._db) return [];
        return this._stmt.getAlarmRules.all();
    }

    insertAlarmRule({ metric, mode, threshold, duration_s, enabled = 1 }) {
        if (this._degraded || !this._db) throw new Error('store not open');
        const now = Date.now();
        const info = this._stmt.insertAlarmRule.run({ metric, mode, threshold, duration_s, enabled, created_at: now, updated_at: now });
        return this._stmt.getAlarmRuleById.get(info.lastInsertRowid);
    }

    updateAlarmRule(id, fields) {
        if (this._degraded || !this._db) throw new Error('store not open');
        const allowed = ['metric', 'mode', 'threshold', 'duration_s', 'enabled'];
        const sets = Object.keys(fields)
            .filter(k => allowed.includes(k))
            .map(k => `${k} = @${k}`)
            .join(', ');
        if (!sets) throw new Error('no valid fields to update');
        this._db.prepare(`UPDATE alarm_rules SET ${sets}, updated_at = @updated_at WHERE id = @id`)
            .run({ ...fields, updated_at: Date.now(), id });
        return this._stmt.getAlarmRuleById.get(id);
    }

    deleteAlarmRule(id) {
        if (this._degraded || !this._db) throw new Error('store not open');
        this._stmt.deleteAlarmRule.run(id);
    }

    insertEvent({ ts, kind, detail }) {
        if (!this._db) throw new Error('store not open');
        this._db.prepare(`INSERT OR REPLACE INTO events (ts, kind, detail) VALUES (?, ?, ?)`)
            .run(ts, kind, detail == null ? null : JSON.stringify(detail));
        this.emit('event', { ts, kind, detail });
    }

    flush({ system, nodes = [] }) {
        if (this._degraded) {
            this._memoryBuffer.push({ ts: system.ts, system, nodes });
            while (this._memoryBuffer.length > 300) this._memoryBuffer.shift();
            this.emit('sample', { ts: system.ts, system, nodes });
            return;
        }
        if (!this._db) throw new Error('store not open');

        if (this._loggingEnabled) {
            const tx = this._db.transaction(() => {
                this._stmt.insertSample.run(system);
                for (const n of nodes) {
                    if (n.msg_count === 0 && n.error_count === 0) continue;
                    this._stmt.insertNodeSample.run({ ts: system.ts, ...n });
                }
            });
            tx();
        }
        this.emit('sample', { ts: system.ts, system, nodes });
    }

    getRecent(limit = 300) {
        if (this._degraded) {
            return this._memoryBuffer.slice(-limit).map(e => e.system).reverse();
        }
        return this._stmt.recentSamples.all(limit);
    }

    getRange(fromTs, toTs, { bucketMs = null } = {}) {
        if (!bucketMs) {
            return this._stmt.rangeRaw.all(fromTs, toTs);
        }
        const b = Math.max(1, Math.floor(Number(bucketMs)));
        return this._db.prepare(`
            SELECT
                (ts / ${b}) * ${b} AS ts,
                AVG(proc_cpu_pct)   AS proc_cpu_pct,
                MAX(proc_rss)       AS proc_rss,
                AVG(event_loop_lag) AS event_loop_lag,
                AVG(sys_cpu_pct)    AS sys_cpu_pct,
                AVG(sys_mem_used)   AS sys_mem_used
            FROM samples
            WHERE ts BETWEEN ? AND ?
            GROUP BY ts / ${b}
            ORDER BY ts ASC
        `).all(fromTs, toTs);
    }

    getNodeStats(nodeId, fromTs, toTs) {
        return this._stmt.nodeStats.all(nodeId, fromTs, toTs);
    }

    getTopNodes(fromTs, toTs, { metric = 'msg_count', n = 10 } = {}) {
        const allowed = new Set(['msg_count', 'avg_process_ms', 'error_count']);
        if (!allowed.has(metric)) throw new Error(`unknown metric: ${metric}`);
        const agg = metric === 'avg_process_ms' ? 'AVG' : 'SUM';
        return this._db.prepare(`
            SELECT node_id, node_type, ${agg}(${metric}) AS value
            FROM node_samples
            WHERE ts BETWEEN ? AND ?
            GROUP BY node_id
            ORDER BY value DESC
            LIMIT ?
        `).all(fromTs, toTs, n);
    }

    getEvents(fromTs, toTs, kinds = []) {
        if (kinds.length === 0) return this._stmt.events.all(fromTs, toTs);
        const placeholders = kinds.map(() => '?').join(',');
        return this._db.prepare(`
            SELECT * FROM events WHERE ts BETWEEN ? AND ? AND kind IN (${placeholders}) ORDER BY ts ASC
        `).all(fromTs, toTs, ...kinds);
    }

    runRetention() {
        const cutoff = Date.now() - this.retentionDays * 86_400_000;
        let deletedSamples = 0, deletedNodeSamples = 0, deletedEvents = 0;
        const tx = this._db.transaction(() => {
            deletedSamples      = this._db.prepare('DELETE FROM samples      WHERE ts < ?').run(cutoff).changes;
            deletedNodeSamples  = this._db.prepare('DELETE FROM node_samples WHERE ts < ?').run(cutoff).changes;
            deletedEvents       = this._db.prepare('DELETE FROM events       WHERE ts < ?').run(cutoff).changes;
        });
        tx();
        try { this._db.pragma('incremental_vacuum'); } catch (_) {}
        const result = { deletedSamples, deletedNodeSamples, deletedEvents, cutoff };
        this.emit('retention', result);
        return result;
    }

    pruneOldestFraction(fraction = 0.1) {
        const total = this._db.prepare('SELECT COUNT(*) c FROM samples').get().c;
        const limit = Math.max(1, Math.floor(total * fraction));
        const cutRow = this._db.prepare('SELECT ts FROM samples ORDER BY ts ASC LIMIT 1 OFFSET ?').get(limit);
        if (!cutRow) return { deletedSamples: 0 };
        const tx = this._db.transaction(() => {
            this._db.prepare('DELETE FROM samples      WHERE ts <= ?').run(cutRow.ts);
            this._db.prepare('DELETE FROM node_samples WHERE ts <= ?').run(cutRow.ts);
            this._db.prepare('DELETE FROM events       WHERE ts <= ?').run(cutRow.ts);
        });
        tx();
        return { deletedSamples: limit };
    }

    getSummary(rangeMs) {
        const now = Date.now();
        const from = now - rangeMs;
        const cols = ['proc_cpu_pct', 'sys_cpu_pct', 'event_loop_lag'];
        const out = {};
        for (const c of cols) {
            const rowsStmt = this._db.prepare(`SELECT ${c} AS v FROM samples WHERE ts >= ? ORDER BY ${c} ASC`);
            const rows = rowsStmt.all(from);
            if (rows.length === 0) { out[c] = null; continue; }
            const min = rows[0].v, max = rows[rows.length - 1].v;
            const sum = rows.reduce((a, r) => a + r.v, 0);
            const avg = sum / rows.length;
            const p95Index = Math.min(rows.length - 1, Math.floor(rows.length * 0.95));
            out[c] = { min, max, avg, p95: rows[p95Index].v };
        }
        return out;
    }
}

module.exports = MetricsStore;
