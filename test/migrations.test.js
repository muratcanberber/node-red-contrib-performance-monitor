const assert = require('assert');
const Database = require('better-sqlite3');
const { runMigrations, CURRENT_VERSION } = require('../lib/migrations');

describe('migrations', function () {
    let db;

    beforeEach(function () { db = new Database(':memory:'); });
    afterEach(function () { db.close(); });

    it('creates schema and meta on fresh DB', function () {
        runMigrations(db);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name).filter(t => t !== 'sqlite_sequence');
        assert.deepStrictEqual(tables, ['alarm_rules', 'events', 'meta', 'node_samples', 'samples']);
        const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        assert.strictEqual(ver.value, String(CURRENT_VERSION));
    });

    it('is idempotent: running twice leaves schema unchanged', function () {
        runMigrations(db);
        runMigrations(db);
        const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
        assert.strictEqual(ver.value, String(CURRENT_VERSION));
    });

    it('creates expected columns on samples', function () {
        runMigrations(db);
        const cols = db.prepare("PRAGMA table_info(samples)").all().map(c => c.name);
        assert.ok(cols.includes('ts'));
        assert.ok(cols.includes('proc_cpu_pct'));
        assert.ok(cols.includes('sys_cpu_pct'));
        assert.ok(cols.includes('container'));
    });

    it('creates expected columns on node_samples', function () {
        runMigrations(db);
        const cols = db.prepare("PRAGMA table_info(node_samples)").all().map(c => c.name);
        assert.ok(cols.includes('ts'));
        assert.ok(cols.includes('node_id'));
        assert.ok(cols.includes('msg_count'));
        assert.ok(cols.includes('avg_process_ms'));
        assert.ok(cols.includes('error_count'));
    });

    it('migration 002 creates alarm_rules table', function () {
        const db = new Database(':memory:');
        runMigrations(db);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        assert.ok(tables.includes('alarm_rules'), 'alarm_rules table must exist after migrations');
    });

    it('alarm_rules table has correct columns', function () {
        const db = new Database(':memory:');
        runMigrations(db);
        const cols = db.prepare("PRAGMA table_info(alarm_rules)").all().map(r => r.name);
        ['id','metric','mode','threshold','duration_s','enabled','created_at','updated_at'].forEach(col => {
            assert.ok(cols.includes(col), `column ${col} must exist`);
        });
    });
});
