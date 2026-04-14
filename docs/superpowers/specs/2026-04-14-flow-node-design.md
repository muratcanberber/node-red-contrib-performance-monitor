# Flow Node — Design

**Date:** 2026-04-14
**Status:** Approved
**Target version:** 2.1.0
**Scope:** Node-RED flow node that outputs live performance metrics as messages, with configurable interval and optional disable of built-in SQLite logging for external sink use cases.

## Context

`node-red-contrib-performance-monitor` v2.0 added a SQLite-backed metrics store and sidebar. This spec adds a first-class Node-RED node so developers can access metrics inside flows — enabling alarm pipelines, external forwarding (InfluxDB, MQTT, Telegram), and custom dashboards. The node is a consumer of `MetricsStore`; it adds no new sampling logic.

## Goals

- Drop-in Node-RED node that outputs a metrics snapshot as `msg.payload`.
- Dual trigger: fires on input message (inject-driven) and/or on a self-ticking interval.
- Option to disable built-in SQLite logging — for users who want the node as sole metric sink (pipe to external storage).
- Include top-N per-node stats in payload (configurable, default on).
- Alarm support via downstream Switch nodes — no built-in threshold logic in the node itself.

## Non-Goals

- Built-in threshold/alarm output port (handled by downstream Switch nodes).
- Historical data querying from the node (report view covers this).
- Anomaly detection (separate subsystem).

## Architecture

```
MetricsStore (existing)
    │
    ├── store.on('sample') ──→ PerfMonitorNode (if interval mode active)
    │
    └── store.getRecent(1) ──→ PerfMonitorNode (if inject-driven)
```

New files:
```
nodes/
  perf-monitor-node/
    perf-monitor-node.js      # node runtime
    perf-monitor-node.html    # node editor UI + help
```

Modified:
```
performance-monitor.js        # register node type, pass store reference
package.json                  # node-red.nodes entry
```

## Node Editor UI

**Properties panel fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| Name | text | — | Optional node label |
| Mode | select | Both | `inject`, `interval`, or `both` |
| Interval | number (ms) | 2000 | Self-tick rate. Hidden when mode = inject |
| Include node stats | checkbox | true | Appends top-10 busiest nodes to payload |
| Disable built-in logging | checkbox | false | Calls `store.setLoggingEnabled(false)` on deploy |

The "Disable built-in logging" checkbox shows a yellow warning: _"All metric history will be lost unless you pipe to an external sink."_

## Output msg Shape

```js
msg.payload = {
  ts: 1776160390000,          // unix ms
  process: {
    cpu: 12.4,                // % — process cpu
    memory: {
      rss: 145000000,
      heapUsed: 89000000,
      heapTotal: 120000000,
      external: 1200000,
      arrayBuffers: 400000
    },
    eventLoopLag: 1.2,        // ms
    pid: 1234,
    uptime: 3600              // seconds
  },
  system: {
    cpu: 34.1,
    memory: {
      used: 8589934592,
      total: 17179869184,
      pct: 50
    },
    disk: {
      used: 107374182400,
      total: 536870912000,
      pct: 20
    }
  },
  nodes: [                    // empty array if "include node stats" off
    {
      id: "abc123",
      type: "http in",
      msgCount: 412,
      avgMs: 3.2,
      errors: 0
    }
    // ... up to 10
  ],
  container: false,           // true if running inside Docker/cgroup
  source: "perf-monitor"      // always present — useful for Switch routing
}

msg.topic = "perf-monitor"
```

## Disable Logging Behaviour

When "Disable built-in logging" is checked:

1. On node deploy, `store.setLoggingEnabled(false)` is called.
2. `MetricsStore.flush()` skips DB writes and retention, but still emits `sample` events (so flow nodes still receive data).
3. If multiple perf-monitor nodes exist in the same flow, any one with logging disabled wins — a `RED.log.warn` is emitted explaining this.
4. On redeploy with logging re-enabled, `store.setLoggingEnabled(true)` restores normal behaviour.

`setLoggingEnabled` must be added to `MetricsStore`.

## Trigger Modes

**Inject-driven:** On input message, node calls `store.getRecent(1)` to get the latest flushed sample and immediately sends it. If no sample exists yet (fresh start), it calls `collector.sampleSystem()` directly for a live reading.

**Interval (self-ticking):** Node subscribes to `store.on('sample')` and forwards each emitted payload. Interval is effectively `pollInterval` of the collector — the node's own "interval" setting only controls the collector's poll rate if this is the only consumer and logging is disabled; otherwise the collector's global `pollInterval` governs.

**Both:** Responds to input messages AND forwards every sample event.

## Alarm Pattern (downstream)

Recommended flow pattern documented in node Help tab:

```
[inject] → [perf-monitor] → [switch: msg.payload.process.cpu > 80] → [notify]
                          → [switch: msg.payload.process.memory.heapUsed > 500e6] → [email]
```

## Error Handling

- If store is in degraded (in-memory) mode, node still outputs metrics — just no history.
- If collector is not yet started (race on boot), node outputs `msg.error` and skips sending `msg.payload`.
- Node status indicator: green dot (outputting), yellow dot (degraded store), red dot (collector unavailable).

## Testing

- `test/perf-monitor-node.test.js`
  - Inject-driven: sends msg → node outputs payload with correct shape.
  - Interval: node subscribes to store sample events, forwards them.
  - `nodes` array present when include-node-stats enabled; empty when disabled.
  - Disable logging: `store.setLoggingEnabled` called on deploy.
  - Status dot reflects store health.

## Acceptance Criteria

- Node appears in Node-RED palette under "monitoring" category.
- Dropping node + wiring inject → node → debug shows full payload within one poll interval.
- Disable logging checkbox prevents DB writes verified by checking DB row count stays flat.
- Switch node downstream can branch on `msg.payload.process.cpu > 80` correctly.
