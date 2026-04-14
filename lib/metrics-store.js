const EventEmitter = require('events');
const fs = require('fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');

class MetricsStore extends EventEmitter {
    constructor(options = {}) {
        super();

        this.dbPath = options.dbPath;
        this.retentionDays = options.retentionDays || 7;
        this.maxDbSizeMB = options.maxDbSizeMB || 500;
        this._db = null;
        this._stmt = {};
        this._degraded = false;
        this._memoryBuffer = [];
    }

    open() {
        this._db = new Database(this.dbPath);
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('synchronous = NORMAL');
        this._db.pragma('auto_vacuum = INCREMENTAL');

        runMigrations(this._db);
        this._prepare();
    }

    openOrDegrade() {
        try {
            this.open();
        } catch (error) {
            this._db = null;
            this._stmt = {};
            this._degraded = true;
            this._memoryBuffer = [];
            this.emit('store:degraded', { error: error.message });
        }
    }

    isDegraded() {
        return this._degraded;
    }

    close() {
        if (this._db) {
            this._db.close();
        }

        this._db = null;
        this._stmt = {};
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

        this._stmt.insertEvent = this._db.prepare(`
            INSERT OR REPLACE INTO events (ts, kind, detail)
            VALUES (?, ?, ?)
        `);

        this._stmt.recentSamples = this._db.prepare(`
            SELECT *
            FROM samples
            ORDER BY ts DESC
            LIMIT ?
        `);

        this._stmt.rangeRaw = this._db.prepare(`
            SELECT *
            FROM samples
            WHERE ts BETWEEN ? AND ?
            ORDER BY ts ASC
        `);

        this._stmt.nodeStats = this._db.prepare(`
            SELECT *
            FROM node_samples
            WHERE node_id = ? AND ts BETWEEN ? AND ?
            ORDER BY ts ASC
        `);

        this._stmt.events = this._db.prepare(`
            SELECT *
            FROM events
            WHERE ts BETWEEN ? AND ?
            ORDER BY ts ASC
        `);
    }

    flush(payload) {
        const system = payload.system;
        const nodes = payload.nodes || [];

        if (this._degraded) {
            this._memoryBuffer.push({ ts: system.ts, system: system, nodes: nodes });

            while (this._memoryBuffer.length > 300) {
                this._memoryBuffer.shift();
            }

            this.emit('sample', {
                ts: system.ts,
                system: system,
                nodes: nodes
            });
            return;
        }

        if (!this._db) {
            throw new Error('store not open');
        }

        this._db.transaction(() => {
            this._stmt.insertSample.run(system);

            for (const nodeSample of nodes) {
                if (nodeSample.msg_count === 0 && nodeSample.error_count === 0) {
                    continue;
                }

                if (!nodeSample.node_id) {
                    throw new Error('node sample requires node_id');
                }

                this._stmt.insertNodeSample.run({
                    ts: system.ts,
                    node_id: nodeSample.node_id,
                    node_type: nodeSample.node_type,
                    msg_count: nodeSample.msg_count,
                    avg_process_ms: nodeSample.avg_process_ms,
                    error_count: nodeSample.error_count,
                    last_error_ts: nodeSample.last_error_ts
                });
            }
        })();

        this.emit('sample', {
            ts: system.ts,
            system: system,
            nodes: nodes
        });

        if (this._isOverSizeLimit()) {
            this.pruneOldestFraction();
        }
    }

    insertEvent(payload) {
        const eventRecord = {
            ts: payload.ts,
            kind: payload.kind,
            detail: payload.detail == null ? null : JSON.stringify(payload.detail)
        };

        if (this._degraded) {
            this.emit('event', payload);
            return;
        }

        if (!this._db) {
            throw new Error('store not open');
        }

        this._stmt.insertEvent.run(eventRecord.ts, eventRecord.kind, eventRecord.detail);
        this.emit('event', payload);
    }

    getRecent(limit = 300) {
        if (this._degraded) {
            return this._memoryBuffer.slice(-limit).map(function (entry) {
                return entry.system;
            }).reverse();
        }

        return this._stmt.recentSamples.all(limit);
    }

    getRange(fromTs, toTs, options = {}) {
        const bucketMs = options.bucketMs || null;

        if (!bucketMs) {
            return this._stmt.rangeRaw.all(fromTs, toTs);
        }

        return this._db.prepare(`
            SELECT
                (CAST(ts / ? AS INTEGER) * ?) AS bucket_ts,
                AVG(proc_cpu_pct) AS proc_cpu_pct,
                MAX(proc_rss) AS proc_rss,
                AVG(event_loop_lag) AS event_loop_lag,
                AVG(sys_cpu_pct) AS sys_cpu_pct,
                AVG(sys_mem_used) AS sys_mem_used,
                AVG(sys_mem_total) AS sys_mem_total,
                AVG(disk_used) AS disk_used,
                AVG(disk_total) AS disk_total
            FROM samples
            WHERE ts BETWEEN ? AND ?
            GROUP BY bucket_ts
            ORDER BY bucket_ts ASC
        `).all(bucketMs, bucketMs, fromTs, toTs).map(function (row) {
            const mappedRow = Object.assign({}, row, { ts: row.bucket_ts });
            delete mappedRow.bucket_ts;
            return mappedRow;
        });
    }

    getNodeStats(nodeId, fromTs, toTs) {
        return this._stmt.nodeStats.all(nodeId, fromTs, toTs);
    }

    getTopNodes(fromTs, toTs, options = {}) {
        const metric = options.metric || 'msg_count';
        const limit = options.n || 10;
        const allowed = new Set(['msg_count', 'avg_process_ms', 'error_count']);
        const aggregate = metric === 'avg_process_ms' ? 'AVG' : 'SUM';

        if (!allowed.has(metric)) {
            throw new Error(`unknown metric: ${metric}`);
        }

        return this._db.prepare(`
            SELECT node_id, node_type, ${aggregate}(${metric}) AS value
            FROM node_samples
            WHERE ts BETWEEN ? AND ?
            GROUP BY node_id
            ORDER BY value DESC
            LIMIT ?
        `).all(fromTs, toTs, limit);
    }

    getEvents(fromTs, toTs, kinds = []) {
        if (this._degraded) {
            return [];
        }

        if (kinds.length === 0) {
            return this._stmt.events.all(fromTs, toTs);
        }

        const placeholders = kinds.map(function () {
            return '?';
        }).join(',');

        return this._db.prepare(`
            SELECT *
            FROM events
            WHERE ts BETWEEN ? AND ? AND kind IN (${placeholders})
            ORDER BY ts ASC
        `).all(fromTs, toTs, ...kinds);
    }

    getSummary(rangeMs) {
        if (this._degraded) {
            return {
                proc_cpu_pct: null,
                sys_cpu_pct: null,
                event_loop_lag: null
            };
        }

        const now = Date.now();
        const fromTs = now - rangeMs;
        const columns = ['proc_cpu_pct', 'sys_cpu_pct', 'event_loop_lag'];
        const summary = {};

        for (const column of columns) {
            const rows = this._db.prepare(`
                SELECT ${column} AS value
                FROM samples
                WHERE ts >= ?
                ORDER BY ${column} ASC
            `).all(fromTs);

            if (rows.length === 0) {
                summary[column] = null;
                continue;
            }

            const values = rows.map(function (row) {
                return row.value;
            }).filter(function (value) {
                return typeof value === 'number' && !Number.isNaN(value);
            });

            if (values.length === 0) {
                summary[column] = null;
                continue;
            }

            const min = values[0];
            const max = values[values.length - 1];
            const sum = values.reduce(function (total, value) {
                return total + value;
            }, 0);
            const p95Index = Math.min(values.length - 1, Math.floor(values.length * 0.95));

            summary[column] = {
                min: min,
                max: max,
                avg: sum / values.length,
                p95: values[p95Index]
            };
        }

        return summary;
    }

    runRetention() {
        if (this._degraded || !this._db) {
            const emptyResult = {
                deletedSamples: 0,
                deletedNodeSamples: 0,
                deletedEvents: 0,
                cutoff: Date.now() - this.retentionDays * 86400000
            };
            this.emit('retention', emptyResult);
            return emptyResult;
        }

        const cutoff = Date.now() - this.retentionDays * 86400000;
        let deletedSamples = 0;
        let deletedNodeSamples = 0;
        let deletedEvents = 0;

        this._db.transaction(() => {
            deletedSamples = this._db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff).changes;
            deletedNodeSamples = this._db.prepare('DELETE FROM node_samples WHERE ts < ?').run(cutoff).changes;
            deletedEvents = this._db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes;
        })();

        try {
            this._db.pragma('incremental_vacuum');
        } catch (_) {
            // Ignore vacuum support differences across SQLite builds.
        }

        const result = {
            deletedSamples: deletedSamples,
            deletedNodeSamples: deletedNodeSamples,
            deletedEvents: deletedEvents,
            cutoff: cutoff
        };

        this.emit('retention', result);
        return result;
    }

    pruneOldestFraction(fraction = 0.1) {
        if (this._degraded || !this._db) {
            return { deletedSamples: 0 };
        }

        const totalRows = this._db.prepare('SELECT COUNT(*) AS count FROM samples').get().count;
        const pruneCount = Math.max(1, Math.floor(totalRows * fraction));
        const cutoffRow = this._db.prepare(`
            SELECT ts
            FROM samples
            ORDER BY ts ASC
            LIMIT 1 OFFSET ?
        `).get(pruneCount - 1);

        if (!cutoffRow) {
            return { deletedSamples: 0 };
        }

        let deletedSamples = 0;

        this._db.transaction(() => {
            deletedSamples = this._db.prepare('DELETE FROM samples WHERE ts <= ?').run(cutoffRow.ts).changes;
            this._db.prepare('DELETE FROM node_samples WHERE ts <= ?').run(cutoffRow.ts);
            this._db.prepare('DELETE FROM events WHERE ts <= ?').run(cutoffRow.ts);
        })();

        return { deletedSamples: deletedSamples };
    }

    _isOverSizeLimit() {
        if (this._degraded || !this.dbPath) {
            return false;
        }

        const maxBytes = this.maxDbSizeMB * 1024 * 1024;
        const trackedPaths = [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`];
        let totalBytes = 0;

        for (const trackedPath of trackedPaths) {
            try {
                if (fs.existsSync(trackedPath)) {
                    totalBytes += fs.statSync(trackedPath).size;
                }
            } catch (_) {
                // Ignore transient filesystem errors while checking size.
            }
        }

        return totalBytes > maxBytes;
    }
}

module.exports = MetricsStore;
