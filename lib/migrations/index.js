const migrations = [
    require('./001-initial')
].sort(function (a, b) {
    return a.version - b.version;
});

const CURRENT_VERSION = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;

function getSchemaVersion(db) {
    try {
        const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        return row ? parseInt(row.value, 10) : 0;
    } catch (_) {
        return 0;
    }
}

function runMigrations(db) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

    const current = getSchemaVersion(db);

    const applyMigrations = function () {
        for (const migration of migrations) {
            if (migration.version > current) {
                migration.up(db);
            }
        }

        db.prepare(`
            INSERT INTO meta (key, value) VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(CURRENT_VERSION));
    };

    if (typeof db.transaction === 'function') {
        db.transaction(applyMigrations)();
    } else {
        applyMigrations();
    }

    return CURRENT_VERSION;
}

module.exports = { runMigrations, getSchemaVersion, CURRENT_VERSION };
