# Persistence Layer — Design

**Date:** 2026-04-13
**Status:** Draft
**Target version:** 2.0.0
**Scope:** First of several subsystems in v2 effort. This spec covers persistence only. Sibling specs (to follow): Node-RED flow node, anomaly detection, external report view, sidebar UI/UX refresh.

## Context

`node-red-contrib-performance-monitor` v1.x is a sidebar-only plugin that samples system/process metrics on-demand and holds no history. v2 aims to add historical reports, in-flow metric access, anomaly detection, and per-node introspection. All of those depend on a persistence layer — this spec.

Current plugin is a single 562-line `performance-monitor.js`. v2 begins by extracting concerns into `lib/` modules and introducing a SQLite-backed metrics store.

## Goals

- Durable history of system, process, and per-node metrics with configurable retention.
- Live event stream for real-time consumers (sidebar, flow node, anomaly engine).
- Query API for historical reports with bucketing/aggregation.
- Clean module boundary: store has no knowledge of HTTP, UI, or Node-RED internals.
- Graceful degradation if DB unavailable (fall back to in-memory buffer).

## Non-Goals

- Sidebar UI/UX redesign (later spec).
- Flow node implementation (later spec, depends on this).
- Anomaly detection logic (later spec, consumes this).
- Report view UI (later spec, queries this).
- Long-term aggregated rollups (raw-only retention chosen — §Retention).

## Architecture

New module layout:

```
performance-monitor.js          # plugin entry — registers plugin, owns lifecycle
lib/
  metrics-store.js              # SQLite + events (read/write API)
  metrics-collector.js          # sampling + RED.hooks per-node instrumentation
  container-detect.js           # existing cgroup logic, extracted unchanged
  http-routes.js                # sidebar HTTP + SSE stream
  migrations/
    001-initial.js              # v1 schema
performance-monitor.html        # unchanged this spec
test/
  metrics-store.test.js
  metrics-collector.test.js
  container-detect.test.js      # existing
  integration.test.js
```

Three concerns, one boundary:

- **Write path:** `MetricsCollector` samples system/process metrics + aggregates per-node stats via `RED.hooks`. Every poll interval it hands a snapshot to `MetricsStore.flush(...)`.
- **Read path:** `MetricsStore` exposes query methods (`getRecent`, `getRange`, `getNodeStats`, `getTopNodes`, `getEvents`, `getSummary`).
- **Live path:** `MetricsStore` is an `EventEmitter`. Emits `sample` after each flush, `event` for deploy/error markers, `retention` after cleanup, `store:degraded` on fallback.

Consumers (sidebar HTTP/SSE, future flow node, future report view) all go through `MetricsStore`. No direct DB access elsewhere.

### Dependency direction

```
performance-monitor.js  →  MetricsCollector  →  MetricsStore
                                             →  container-detect
                        →  http-routes       →  MetricsStore
```

Store depends on nothing Node-RED-specific. Collector depends on store interface only. HTTP depends on store interface only.

## Data Schema

All timestamps are unix ms (INTEGER).

```sql
-- System + process metrics, one row per flush
CREATE TABLE samples (
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
CREATE INDEX idx_samples_ts ON samples(ts);

-- Per-node metrics. One row per node per flush, only for active nodes.
CREATE TABLE node_samples (
  ts              INTEGER,
  node_id         TEXT,
  node_type       TEXT,
  msg_count       INTEGER,
  avg_process_ms  REAL,
  error_count     INTEGER,
  last_error_ts   INTEGER,
  PRIMARY KEY (ts, node_id)
);
CREATE INDEX idx_node_samples_node_ts ON node_samples(node_id, ts);

-- Deploy/lifecycle markers (used later by anomaly engine to mask false positives)
CREATE TABLE events (
  ts     INTEGER PRIMARY KEY,
  kind   TEXT,    -- 'deploy' | 'start' | 'stop' | 'error'
  detail TEXT     -- JSON
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- seeded: ('schema_version', '1')
```

Rationale:

- Separate `node_samples` avoids sparse wide rows and scales with node count.
- Only insert `node_samples` rows for nodes with `msg_count > 0` or `error_count > 0` in the window → idle flows cost near-zero DB growth.
- `events` table exists to let the future anomaly engine suppress spike alarms during deploys.

## Write Path

### Collector (`lib/metrics-collector.js`)

Pure sampling + aggregation. No storage knowledge.

- Poll tick every `pollInterval` ms (default 2000, configurable).
- System/process snapshot via extracted existing functions (`getCpuUsage`, `getMemory`, `getEventLoopLag`, `getSystemStats`, `getDisk`). Reframed as pure functions returning snapshots.
- Per-node instrumentation via `RED.hooks`:
  - `preRoute` — record `process.hrtime.bigint()` start per msg.
  - `postRoute` — compute delta, update `Map<nodeId, {type, count, sumMs, errors, lastErrorTs}>`.
  - Node error hook — increment `errors`, set `lastErrorTs`.
- Hooks are try/caught individually: one faulty node can never crash the collector.
- Deploy/lifecycle events captured via `RED.events.on('flows:started'|'flows:stopped')` → store.insertEvent.

### Flush cycle

Every `pollInterval`:

1. Collector snapshots system sample + drains per-node map (resets counters after read).
2. Calls `store.flush({system, nodes})`.
3. Store opens one transaction:
   - `INSERT INTO samples ...`
   - `INSERT INTO node_samples ...` for each node in snapshot (skip rows where count = 0 AND errors = 0).
4. Commit.
5. Emit `sample` event with the flushed payload.

### SQLite configuration (on open)

- `PRAGMA journal_mode = WAL` — concurrent readers during writer.
- `PRAGMA synchronous = NORMAL` — not a bank; durability trade acceptable.
- `PRAGMA auto_vacuum = INCREMENTAL` — enables post-retention vacuum.
- Prepared statements cached on init (`insertSample`, `insertNodeSample`, `insertEvent`, `deleteOlderThan`, etc.).

### Backpressure

- If a flush takes > 500ms, log warn via `RED.log.warn`.
- If DB file exceeds `maxDbSizeMB` cap after flush, trigger immediate retention pass.
- If flush throws, skip that tick; aggregator keeps accumulating and merges into next tick (no data loss on transient error).

## Read Path + Live Events

### Read API (synchronous — better-sqlite3 is sync)

```js
store.getRecent(limit = 300)
  // last N samples joined with top active nodes per sample

store.getRange(fromTs, toTs, { bucketMs = null, metrics = ['*'] } = {})
  // raw rows if bucketMs null, else SQL GROUP BY (ts / bucketMs) with AVG/MAX

store.getNodeStats(nodeId, fromTs, toTs, { bucketMs = null } = {})
  // single-node history

store.getTopNodes(fromTs, toTs, { metric = 'msg_count', n = 10 } = {})
  // e.g. top 10 nodes by cpu / msg count / errors in window

store.getEvents(fromTs, toTs, kinds = [])
  // deploy/error markers

store.getSummary(rangeMs)
  // min/max/avg/p95 rollup for UI header
```

Bucketing is SQL-side (`GROUP BY (ts / :bucket)`). Never fetch and aggregate in JS.

### Live events (EventEmitter on store)

- `sample` → `{ts, system, nodes: [{node_id, node_type, msg_count, avg_process_ms, error_count, last_error_ts}]}` — emitted after each successful flush.
- `event` → `{ts, kind, detail}` — deploy/error markers as they're inserted.
- `retention` → `{deletedSamples, deletedNodeSamples, deletedEvents}` — after cleanup pass.
- `store:degraded` → emitted once when store falls back to in-memory mode.

### Sidebar integration

Current sidebar polls an HTTP endpoint every 2s. `http-routes.js` gains a new `GET /performance-monitor/stream` SSE endpoint that subscribes to `store.on('sample')` and pipes payloads to the browser. Existing poll endpoint remains one release for backward-compat, then removed.

## Retention + Cleanup

### Settings (exposed in sidebar settings UI)

- `retentionDays` — default 7, range 1–90.
- `maxDbSizeMB` — default 500.

### Cleanup job

- Scheduled every 1 hour via `setInterval`.
- Also triggered immediately on DB size breach post-flush.
- Also triggered immediately when user lowers `retentionDays` in settings.

Operation:

1. Compute cutoff: `now - retentionDays * 86400000`.
2. In one transaction: `DELETE FROM samples WHERE ts < :cutoff`, same for `node_samples`, `events`.
3. `PRAGMA incremental_vacuum` to reclaim pages.
4. Emit `retention` event with counts.

### Size breach fallback

If DB size still > `maxDbSizeMB` after retention (e.g. retentionDays window still too large for activity volume), prune oldest 10% of `samples` by `ts` and cascade-delete matching `node_samples` / `events`. Log warn. Never bricks the DB; always keeps recent data.

### Migrations

First launch: no DB → create schema at version 1, seed `meta.schema_version = 1`.

On subsequent launches: read `meta.schema_version`. If < current, run ordered migration scripts from `lib/migrations/` inside a transaction. Migrations are idempotent and versioned. Migration failure halts plugin load (don't corrupt data). User gets a clear `RED.log.error` + banner in sidebar.

## Error Handling

- DB open fail (permissions, corrupt file) → log via `RED.log.error`, fall back to in-memory ring buffer (bounded to last 300 samples). Sidebar keeps working; no history persists. Emit `store:degraded`. UI shows banner.
- Flush fail → log, skip tick, keep aggregator state, merge into next flush.
- Hook errors → caught per-hook. A faulty user node cannot crash the collector. Error increments that node's `error_count`.
- Schema migration fail → halt plugin load with clear error. Refuse to run against unknown/partial schema.
- Retention delete fail → log warn, retry next cycle. Not fatal.

## Testing

Framework: existing `mocha` + `sinon`. Runs on GitHub Actions today — must keep passing.

- `test/metrics-store.test.js`
  - Schema creation on fresh DB.
  - Insert/read round-trip for samples, node_samples, events.
  - Bucketing math (SQL `GROUP BY` aggregates correct).
  - Retention pruning (cutoff correctness, incremental vacuum runs).
  - Size-breach aggressive prune.
  - Migration from schema v0 (fresh) to current.
  - Fallback to in-memory on DB open failure.

- `test/metrics-collector.test.js`
  - Hook registration against stubbed `RED.hooks`.
  - Per-node aggregation counters.
  - Drain/reset semantics (double-drain returns empty).
  - Deploy event capture via stubbed `RED.events`.
  - One throwing hook doesn't break the tick.

- `test/integration.test.js`
  - Collector + store end-to-end using real `better-sqlite3` with temp DB file.
  - WAL mode effective (concurrent read while write).
  - Fake timers drive flush cycle.

Most store tests can use `:memory:` SQLite for speed. WAL/retention tests use a temp file that's cleaned up in `afterEach`.

Coverage target: store ≥ 90%, collector ≥ 85%.

CI note: `better-sqlite3` ships prebuilt binaries for node 14/16/18/20 on linux/mac/windows — no compilation needed in GitHub Actions.

## Configuration

Defaults baked into the plugin; all override-able via Node-RED settings:

| Key | Default | Range |
|---|---|---|
| `pollInterval` | 2000 ms | 500–60000 |
| `retentionDays` | 7 | 1–90 |
| `maxDbSizeMB` | 500 | 50–10000 |
| `dbPath` | `<userDir>/performance-monitor.db` | fixed in v2.0 |

Per the brainstorm decision, `dbPath` is hard-coded to `<userDir>/performance-monitor.db` in v2.0 (follows Node-RED convention). Making it user-configurable is deferred to a later minor release if Docker volume patterns demand it.

## Migration from v1.x Users

- Fresh DB created in userDir on first post-upgrade launch. No prior history to migrate (v1 had none).
- Settings UI gains `retentionDays` + `maxDbSizeMB` controls.
- `package.json`:
  - Add `better-sqlite3` runtime dep.
  - Bump `node-red.version` to `>=1.1.0` (hooks API requirement).
  - Bump package version to `2.0.0`.
- `README.md`:
  - Remove "zero native dependencies" claim.
  - Add "SQLite-backed history" feature bullet.

## Open Questions Deferred to Sibling Specs

- How the flow node exposes metrics (payload shape, trigger semantics) — Node-RED node spec.
- Anomaly thresholds, baseline windows, alert channels — anomaly spec.
- Report view routes, chart types, filters — report view spec.
- Sidebar visual refresh, new themes — sidebar UX spec.

## Boundary Self-Test

- Swap SQLite for Postgres? Only `metrics-store.js` changes.
- Test collector without a DB? Pass a mock store object; collector only calls `flush(...)`.
- Change per-node schema? `node_samples` columns + migration; SSE payload shape is stable at store boundary, UI unaffected.
- Add a new consumer (e.g. webhook on spike)? Subscribe to `store.on('sample')`.

## Acceptance Criteria

- Fresh install creates `<userDir>/performance-monitor.db` with schema v1.
- With a running flow doing 100 msg/s across 10 nodes, flush completes < 50ms typical.
- Sidebar receives live sample events via SSE within 2 × pollInterval of a metric change.
- Retention pass on a 7-day-full DB completes < 2s and reduces file size.
- DB open failure does not crash Node-RED; plugin enters degraded mode and surfaces the state.
- All existing tests still pass on GitHub Actions; new tests hit coverage targets.
