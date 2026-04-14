# Anomaly Detection — Design

**Date:** 2026-04-14
**Status:** Approved
**Target version:** 2.3.0
**Scope:** Backend anomaly detector that monitors the metrics stream, evaluates alarm rules, detects security-relevant patterns, and fires alerts via Node-RED runtime events and the flow node output. Depends on persistence layer (v2.0) and report view (v2.2, which owns alarm_rules schema).

## Context

v2.2 introduces alarm rule management in the report page. This spec implements the evaluation engine: `lib/anomaly-detector.js`. It subscribes to `MetricsStore` sample events, evaluates user-defined alarm rules plus built-in security patterns, persists anomaly events, and fires alerts through two channels: Node-RED notification bar and the perf-monitor flow node output port.

## Goals

- Evaluate user-defined alarm rules (fixed threshold and statistical auto-baseline) on every sample.
- Detect built-in security patterns: sustained CPU spike (crypto-mining), monotonic heap growth (memory leak / injection), event loop block (DoS), traffic anomaly (crash / kill signal).
- Cooldown per metric — one alert per anomaly episode, not per sample.
- Persist anomaly events to `events` table (kind: `'anomaly'`) for the report view log.
- Fire alerts via RED runtime event (notification bar) and flow node output.
- Configurable: users can enable/disable individual built-in patterns and tune thresholds via the alarm rules UI.

## Non-Goals

- Machine-learning based detection (rolling statistical baseline is the extent of "auto-learning").
- Network traffic analysis (only Node-RED process and system metrics).
- Remediation actions (alerts only — no automatic process restarts or flow stops).
- External webhook / email delivery (that's downstream Switch + flow nodes).

## Architecture

```
MetricsStore
    └── on('sample') ──→ AnomalyDetector.evaluate(sample)
                              │
                              ├── evaluate user alarm_rules (from store)
                              ├── evaluate built-in security patterns
                              │
                              ├── anomaly detected?
                              │     ├── cooldown check (skip if in cooldown)
                              │     ├── store.insertEvent({ kind: 'anomaly', ... })
                              │     ├── RED.events.emit('runtime-event', { ... })   → notification bar
                              │     └── collector.emitAlarm({ ... })                → flow node output
                              └── no anomaly → update rolling state only
```

New file:
```
lib/anomaly-detector.js
```

Modified:
```
performance-monitor.js        # instantiate AnomalyDetector, wire to store + collector
lib/metrics-collector.js      # add emitAlarm(payload) method
```

## Detector Lifecycle

Instantiated in `performance-monitor.js` after store and collector are ready:

```js
const detector = new AnomalyDetector({ store, collector, RED });
detector.start();   // subscribes to store 'sample' events, loads rules from DB
detector.stop();    // unsubscribes, clears state
```

On `store.on('sample')`: calls `detector.evaluate(sample)`.

Rules are reloaded from `alarm_rules` table every 60s (or immediately on `rules:changed` event emitted by the alarm-rules HTTP route after any CRUD operation).

## Evaluators

### User-defined alarm rules

For each enabled rule in `alarm_rules`:

**Fixed threshold:**
```
sustained_breach = sample[metric] > rule.threshold
                   for rule.duration_s consecutive seconds
```
Uses a per-rule sliding window of recent samples (ring buffer, max `duration_s / pollInterval` entries).

**Statistical (auto-baseline):**
```
baseline_mean = mean of last 3600s of samples[metric]
baseline_std  = std of last 3600s of samples[metric]
breach = sample[metric] > baseline_mean + rule.threshold * baseline_std
         sustained for rule.duration_s
```
Baseline computed from in-memory ring buffer (last 1800 samples at 2s interval = 1 hour). Falls back to fixed if fewer than 30 samples exist (not enough baseline).

### Built-in security patterns

These run independently of user rules. Each can be disabled via a special alarm rule with `metric = 'builtin:<name>'` and `enabled = 0`.

| Pattern | Metric | Condition | Default threshold | Duration |
|---|---|---|---|---|
| CPU spike (crypto-mining) | `proc_cpu_pct` | > threshold | 90% | 60s |
| Heap growth (leak/injection) | `proc_heap_used` | slope > limit | 20 MB/min | 5min window |
| Event loop block (DoS) | `event_loop_lag` | > threshold | 500ms | 10s |
| Traffic drop (crash/kill) | total `msg_count` | drops > 90% vs 5min avg | — | 30s |
| Traffic spike (DDoS) | total `msg_count` | > baseline + 5σ | — | 30s |

**Heap growth** uses linear regression over a rolling 5-minute window of heap samples. Slope (MB/min) is compared to threshold.

**Traffic anomalies** aggregate `msg_count` across all nodes from the sample's `nodes` array.

## Cooldown

Per `(metric, rule_id)` pair — or `(metric, 'builtin')` for built-in patterns:
- On anomaly first confirmed: fire alert, record `{ activeUntil: now + cooldownMs }`.
- `cooldownMs` = `max(rule.duration_s * 2, 60) * 1000` — at least 60s.
- While in cooldown: no re-alert. Cooldown resets when metric drops back below threshold for `duration_s`.
- Prevents alert storms on noisy metrics.

## Alert Payload

```js
// Emitted to RED.events and flow node output:
{
  ts: 1776160390000,
  kind: 'anomaly',
  pattern: 'cpu_spike',           // rule id or builtin name
  metric: 'proc_cpu_pct',
  value: 94.2,
  threshold: 90,
  mode: 'fixed',                  // or 'statistical'
  durationMs: 62000,
  severity: 'high',               // 'low' | 'medium' | 'high' | 'critical'
  message: 'Process CPU 94.2% sustained for 62s (threshold: 90%). Possible crypto-mining.',
  deployNearby: true              // true if a deploy event exists within ±5min
}
```

`deployNearby: true` is a hint to the report UI to flag as possible false positive (deploy redeploys all nodes, spikes CPU briefly).

## Severity Mapping

| Pattern | Severity |
|---|---|
| CPU spike | high |
| Traffic spike | medium |
| Heap growth | high |
| Event loop block | critical |
| Traffic drop | critical |
| User rule (fixed) | medium |
| User rule (statistical) | medium |

## Alert Channels

**Node-RED notification bar:**
```js
RED.events.emit('runtime-event', {
  id: 'perf-monitor:anomaly',
  retain: false,
  payload: { type: 'warning', text: alert.message }
});
```

**Flow node output:**
`MetricsCollector.emitAlarm(alertPayload)` — collector emits an `'alarm'` event. Each perf-monitor flow node instance subscribes to `collector.on('alarm')` and sends `msg = { payload: alertPayload, topic: 'perf-monitor:alarm' }` on its output port.

## State Management

AnomalyDetector holds in-memory state only:
- Rolling sample buffer (ring buffer, 1800 entries) for baseline calculation.
- Per-rule sliding windows for duration tracking.
- Cooldown registry `Map<key, { activeUntil, resolvedAt }>`.

State is lost on restart — baseline rebuilds over the first hour of operation. This is acceptable: the detector is conservative for the first hour (statistical mode falls back to fixed).

## Error Handling

- Rule load failure: log warn, skip rule evaluation for that tick.
- Evaluator throws: catch per-pattern, log warn, never crash the detector.
- `store.insertEvent` fails: log warn, still fire RED event (alert must get through even if persistence fails).
- Collector not available: skip flow node channel, fire RED event only.

## Testing

- `test/anomaly-detector.test.js`
  - Fixed threshold: sample at threshold-1 → no alert. Sample at threshold+1 for duration → alert.
  - Cooldown: second breach within cooldown window → no second alert.
  - Statistical: baseline mean + N*σ formula fires correctly.
  - Built-in CPU spike: 90% sustained 60s → high severity alert.
  - Heap growth: positive slope > 20MB/min → alert.
  - Event loop block: lag > 500ms for 10s → critical alert.
  - Traffic drop: msg_count drops 90% → critical alert.
  - `deployNearby` flag set when deploy event within ±5min.
  - Rule reload: CRUD operation triggers immediate re-read of rules.

## Acceptance Criteria

- Stress Node-RED CPU to 95% for 60s → anomaly event in DB + Node-RED notification.
- perf-monitor flow node in a test flow receives alarm msg on its output.
- Heap leak simulation (allocate large buffer in function node) → heap growth anomaly within 5min.
- Disable built-in CPU spike pattern via alarm rules UI → no alert fires on CPU stress.
- Deploy flows → `deployNearby: true` on any alerts fired within 5min.
- Detector restart → state rebuilds, no false alerts in first 30 samples.
