'use strict';

module.exports = {
    version: 2,
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS alarm_rules (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                metric     TEXT NOT NULL,
                mode       TEXT NOT NULL,
                threshold  REAL,
                duration_s INTEGER NOT NULL,
                enabled    INTEGER DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        `);
    }
};
