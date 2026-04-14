const assert = require('assert');
const Database = require('better-sqlite3');
const { CURRENT_VERSION, getSchemaVersion, runMigrations } = require('../lib/migrations');
const initialMigration = require('../lib/migrations/001-initial');

describe('migrations', function () {
    let db;

    beforeEach(function () {
        db = new Database(':memory:');
    });

    afterEach(function () {
        db.close();
    });

    it('exposes the initial migration as version 1', function () {
        assert.strictEqual(initialMigration.version, 1);
    });

    it('creates schema and records the current version on a fresh database', function () {
        const appliedVersion = runMigrations(db);
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all().map(function (row) {
            return row.name;
        });

        assert.strictEqual(appliedVersion, CURRENT_VERSION);
        assert.strictEqual(getSchemaVersion(db), CURRENT_VERSION);
        assert.deepStrictEqual(tables, ['events', 'meta', 'node_samples', 'samples']);
    });

    it('is idempotent when run multiple times', function () {
        runMigrations(db);
        runMigrations(db);

        const versionRows = db.prepare("SELECT value FROM meta WHERE key='schema_version'").all();

        assert.strictEqual(versionRows.length, 1);
        assert.strictEqual(versionRows[0].value, String(CURRENT_VERSION));
    });

    it('creates the expected columns on samples', function () {
        runMigrations(db);

        const columns = db.prepare('PRAGMA table_info(samples)').all().map(function (column) {
            return column.name;
        });

        assert.ok(columns.includes('ts'));
        assert.ok(columns.includes('proc_cpu_pct'));
        assert.ok(columns.includes('sys_cpu_pct'));
        assert.ok(columns.includes('container'));
    });

    it('creates the expected columns on node_samples', function () {
        runMigrations(db);

        const columns = db.prepare('PRAGMA table_info(node_samples)').all().map(function (column) {
            return column.name;
        });

        assert.ok(columns.includes('ts'));
        assert.ok(columns.includes('node_id'));
        assert.ok(columns.includes('msg_count'));
        assert.ok(columns.includes('avg_process_ms'));
        assert.ok(columns.includes('error_count'));
    });
});
