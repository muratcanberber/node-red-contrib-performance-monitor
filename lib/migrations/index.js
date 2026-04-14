const migrations = [
    require('./001-initial')
].sort((a, b) => a.version - b.version);

const CURRENT_VERSION = migrations[migrations.length - 1].version;

function getSchemaVersion(db) {
    const row = db.prepare(`
        SELECT value FROM meta WHERE key='schema_version'
    `).get();
    return row ? parseInt(row.value, 10) : 0;
}

function runMigrations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const current = getSchemaVersion(db);

    const tx = db.transaction(() => {
        for (const m of migrations) {
            if (m.version > current) {
                m.up(db);
            }
        }
        db.prepare(`
            INSERT INTO meta (key, value) VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(CURRENT_VERSION));
    });
    tx();
    return CURRENT_VERSION;
}

module.exports = { runMigrations, getSchemaVersion, CURRENT_VERSION };
