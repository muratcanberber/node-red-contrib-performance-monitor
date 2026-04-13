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
    }

    flush({ system, nodes = [] }) {
        if (!this._db) throw new Error('store not open');

        const tx = this._db.transaction(() => {
            this._stmt.insertSample.run(system);
            for (const n of nodes) {
                if (n.msg_count === 0 && n.error_count === 0) continue;
                this._stmt.insertNodeSample.run({ ts: system.ts, ...n });
            }
        });
        tx();
        this.emit('sample', { ts: system.ts, system, nodes });
    }

    getRecent(limit = 300) {
        return this._stmt.recentSamples.all(limit);
    }
}

module.exports = MetricsStore;
