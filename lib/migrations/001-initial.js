module.exports = {
    version: 1,
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS samples (
                ts              INTEGER PRIMARY KEY,
                proc_cpu_pct    REAL,
                proc_rss        INTEGER,
                proc_heap_used  INTEGER,
                proc_heap_total INTEGER,
                event_loop_lag  REAL,
                sys_cpu_pct     REAL,
                sys_mem_used    INTEGER,
                sys_mem_total   INTEGER,
                disk_used       INTEGER,
                disk_total      INTEGER,
                container       INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);

            CREATE TABLE IF NOT EXISTS node_samples (
                ts              INTEGER NOT NULL,
                node_id         TEXT NOT NULL,
                node_type       TEXT,
                msg_count       INTEGER,
                avg_process_ms  REAL,
                error_count     INTEGER,
                last_error_ts   INTEGER,
                PRIMARY KEY (ts, node_id)
            );
            CREATE INDEX IF NOT EXISTS idx_node_samples_node_ts ON node_samples(node_id, ts);

            CREATE TABLE IF NOT EXISTS events (
                ts     INTEGER PRIMARY KEY,
                kind   TEXT,
                detail TEXT
            );

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }
};
