# Report View — Design

**Date:** 2026-04-14
**Status:** Approved
**Target version:** 2.2.0
**Scope:** Standalone historical metrics dashboard at `/performance-monitor/report`. Depends on persistence layer (v2.0) and flow node (v2.1).

## Context

The v2.0 sidebar shows live metrics only. This spec adds a full-screen historical dashboard where operators can view time-series charts, set custom time ranges, manage alarm rules, and review anomaly logs. It is served by Node-RED's `httpAdmin` router and consumes the existing HTTP API (`/performance-monitor/range`, `/performance-monitor/summary`, `/performance-monitor/stream`).

## Goals

- Full-screen standalone page at `/performance-monitor/report`.
- Time-series charts for CPU, memory, event loop lag with custom time range selector.
- Top nodes table (throughput, avg processing time, error count).
- Alarm rule management UI — create, edit, delete rules with fixed or statistical modes.
- Anomaly log panel showing detected anomalies with chart markers.
- Live updates via existing SSE stream — no page refresh needed.
- Alarm rules persisted in SQLite (`alarm_rules` table).

## Non-Goals

- Authentication/access control (deferred — Node-RED's own auth covers admin routes).
- Mobile-optimised layout (desktop-first).
- Export to PDF/CSV (deferred).
- Embedding inside Node-RED editor (standalone only).

## Architecture

```
Browser (report page)
    │
    ├── GET /performance-monitor/report          → serves HTML page (new route)
    ├── GET /performance-monitor/range?...       → historical data (existing)
    ├── GET /performance-monitor/summary?...     → KPI header (existing)
    ├── GET /performance-monitor/stream          → SSE live updates (existing)
    ├── GET /performance-monitor/alarm-rules     → list rules (new)
    ├── POST /performance-monitor/alarm-rules    → create rule (new)
    ├── PUT /performance-monitor/alarm-rules/:id → update rule (new)
    └── DELETE /performance-monitor/alarm-rules/:id → delete rule (new)
```

New files:
```
lib/
  report-page.html            # standalone dashboard HTML (vanilla JS + Chart.js CDN)
lib/http-routes.js            # add report page route + alarm-rules CRUD (modified)
lib/metrics-store.js          # add alarm_rules table via migration (modified)
lib/migrations/
  002-alarm-rules.js          # schema migration for alarm_rules table
```

## Data Schema Addition

```sql
CREATE TABLE alarm_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  metric      TEXT NOT NULL,    -- 'proc_cpu_pct' | 'proc_heap_used' | 'event_loop_lag' | ...
  mode        TEXT NOT NULL,    -- 'fixed' | 'statistical'
  threshold   REAL,             -- fixed mode: raw value. statistical: N standard deviations
  duration_s  INTEGER NOT NULL, -- seconds metric must breach before firing
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

Alarm evaluation lives in `lib/anomaly-detector.js` (separate spec) — `http-routes.js` only manages CRUD.

## Page Layout

**Top navigation bar (dark):**
- Plugin name + live indicator (green dot when SSE connected, grey when disconnected).
- Time range selector: Last 1h / 6h / 24h / 7d / Custom range (date-time pickers).
- ⚙ Alarms button — opens alarm panel.

**KPI strip (4 tiles):**
- Process CPU % (with delta vs period start).
- Heap Used MB (with delta).
- Event Loop Lag ms (with status label).
- Active Alarms count (red if >0).

**Charts grid (2×2):**
1. CPU — process vs system (dual line, different colours).
2. Memory — heap used vs RSS (dual line).
3. Event Loop Lag (single line, threshold reference line overlay).
4. Top Nodes — table: node id, type, msg count, avg ms, error count.

All charts built with Chart.js (loaded from CDN). Anomaly events render as vertical red bands and markers on affected charts.

**Alarm panel (right-side drawer):**
- Triggered by ⚙ Alarms button, slides in over the page (backdrop dims).
- Lists existing rules (metric, condition summary, mode, actions).
- "New alarm rule" form at bottom:
  - Metric dropdown (all available metrics).
  - Mode: Fixed threshold or Statistical (auto-baseline).
  - Threshold / σ input + duration input.
  - Alert via checkboxes: Node-RED notification, flow node output.
  - Save button → POST /performance-monitor/alarm-rules.
- Edit/Delete per existing rule.

**Anomaly log (bottom panel, collapsible):**
- Chronological list of detected anomalies from `events` table where `kind = 'anomaly'`.
- Each entry: metric name, severity, timestamp, duration, description, nearby deploy marker note.

## Time Range Handling

- Default view: last 6 hours, bucket 30s.
- Custom range: two datetime inputs. Bucket auto-selected: <2h → 10s, <24h → 1min, <7d → 10min.
- On range change: re-fetch `/performance-monitor/range?from=&to=&bucket=` and re-render charts.
- SSE appends live samples to chart without re-fetch — chart shifts left as new points arrive.

## Live Updates (SSE)

On page load, connect to `/performance-monitor/stream`. On each `sample` event:
1. Update KPI tiles.
2. Append new data point to all charts (shift oldest off if > max display points).
3. If anomaly alarm fires, prepend to anomaly log and highlight relevant chart.

On SSE disconnect: show grey "DISCONNECTED" indicator, retry after 5s.

## Alarm Rule Evaluation

Evaluation runs inside `AnomalyDetector` (see anomaly spec). The report page only manages rule definitions via CRUD API. The detector reads rules from the store on each tick and evaluates them.

**Fixed threshold:** `current_value > threshold` sustained for `duration_s` seconds.

**Statistical:** baseline = rolling mean of last 1 hour of samples. Alert when `current_value > baseline + N * stddev` sustained for `duration_s`.

## Error Handling

- Range query returns empty: charts render empty state with message "No data for this range."
- SSE fails: indicator goes grey, charts freeze at last data, retry automatically.
- Alarm rule save fails: inline error message in the form.
- DB unavailable (degraded mode): page shows banner "Running in-memory — no historical data available."

## Technology

- Vanilla JS + Chart.js (loaded from CDN, pinned version in HTML).
- No build step — single `report-page.html` file served statically from `httpAdmin`.
- CSS: custom variables for theming (dark nav, light chart area, consistent with Node-RED aesthetic).

## Testing

- `test/report-routes.test.js`
  - `GET /performance-monitor/report` returns 200 with HTML content-type.
  - `GET /performance-monitor/alarm-rules` returns rules array.
  - `POST /performance-monitor/alarm-rules` creates and returns rule with id.
  - `PUT /performance-monitor/alarm-rules/:id` updates rule.
  - `DELETE /performance-monitor/alarm-rules/:id` removes rule.
  - Invalid metric name on POST → 400.

## Acceptance Criteria

- Navigate to `/performance-monitor/report` in browser, see full dashboard with live-updating charts.
- Change time range to "Last 24 hours" — charts reload with bucketed historical data.
- Create alarm rule CPU > 80% fixed, 30s — rule appears in list.
- Trigger CPU load — alarm appears in anomaly log and KPI tile turns red.
- SSE disconnect (kill container network briefly) — page shows grey indicator, reconnects within 10s.
