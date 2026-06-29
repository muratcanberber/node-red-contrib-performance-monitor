'use strict';

let _DatabaseSync = null;
let _loaded = false;

function _load() {
    if (_loaded) return _DatabaseSync;
    _loaded = true;
    try {
        // node:sqlite is built in since Node 22.5 (flag-free since 22.13).
        ({ DatabaseSync: _DatabaseSync } = require('node:sqlite'));
    } catch (_) {
        _DatabaseSync = null;
    }
    return _DatabaseSync;
}

function isAvailable() {
    return _load() != null;
}

function openDatabase(dbPath) {
    const DatabaseSync = _load();
    if (!DatabaseSync) throw new Error('node:sqlite is not available in this runtime');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    return db;
}

function makeTx(db) {
    return function tx(fn) {
        db.exec('BEGIN');
        try {
            fn();
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (_) {}
            throw err;
        }
    };
}

module.exports = { isAvailable, openDatabase, makeTx };
