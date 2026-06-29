// test/sqlite-engine.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const engine = require('../lib/storage/sqlite-engine');

function tempDbPath() {
    return path.join(os.tmpdir(), `pm-eng-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('sqlite-engine', function () {
    let dbPath, db;
    afterEach(function () {
        if (db) { try { db.close(); } catch (_) {} db = null; }
        for (const suffix of ['', '-wal', '-shm']) {
            if (dbPath && fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
        }
    });

    it('reports availability on Node >= 22.13', function () {
        assert.strictEqual(engine.isAvailable(), true);
    });

    it('opens a database in WAL mode', function () {
        dbPath = tempDbPath();
        db = engine.openDatabase(dbPath);
        const row = db.prepare('PRAGMA journal_mode').get();
        assert.strictEqual(row.journal_mode, 'wal');
    });

    it('makeTx commits on success', function () {
        dbPath = tempDbPath();
        db = engine.openDatabase(dbPath);
        db.exec('CREATE TABLE t (v INTEGER)');
        const tx = engine.makeTx(db);
        tx(() => { db.prepare('INSERT INTO t (v) VALUES (?)').run(1); });
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM t').get().c, 1);
    });

    it('makeTx rolls back and rethrows on error', function () {
        dbPath = tempDbPath();
        db = engine.openDatabase(dbPath);
        db.exec('CREATE TABLE t (v INTEGER NOT NULL)');
        const tx = engine.makeTx(db);
        assert.throws(() => {
            tx(() => {
                db.prepare('INSERT INTO t (v) VALUES (?)').run(1);
                db.prepare('INSERT INTO t (v) VALUES (?)').run(null); // violates NOT NULL
            });
        });
        assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM t').get().c, 0, 'first insert must be rolled back');
    });
});
