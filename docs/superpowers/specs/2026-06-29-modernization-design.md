# Performance Monitor — Modernization & Professionalization (v3.0)

**Date:** 2026-06-29
**Status:** Design / awaiting review
**Target:** Node-RED 5.0 (Node.js ≥ 22.9, recommended 24)

## 1. Goal

Take `node-red-contrib-performance-monitor` from an "amateur" to a "professional"
package across four axes, decided with the maintainer:

1. **Visual & vertical density** — compact, professional sidebar that fits far more
   in less vertical space, embedded in the Node-RED look & feel.
2. **Node-RED 5 compatibility** — works with NR5's restructured editor (split
   sidebars, built-in dark theme, accessibility), no breakage on older behaviors.
3. **Code quality** — modular editor source built with esbuild, clear boundaries,
   lint/format/CI, stronger test coverage.
4. **Repo & package hygiene** — remove committed artifacts, clean published files,
   professional README/CHANGELOG/release flow.

This is a **single coherent release (v3.0)**, not a rewrite. Server-side logic in
`lib/` is already modular and well-tested; we preserve its behavior and public HTTP
API while swapping the storage engine and rebuilding the editor layer.

## 2. Key decisions (locked with maintainer)

| Area | Decision |
|---|---|
| Build | esbuild bundles modular `src/editor/` → single `performance-monitor.html` |
| Theme | **Single** theme, inherits Node-RED CSS variables (light/dark automatic) |
| Storage | Migrate to built-in **`node:sqlite`** + in-memory fallback; drop `better-sqlite3` |
| Layout | Dense metric **rows** with inline bar + micro-sparkline, click-to-expand detail |
| Scope | Keep all features (history, flow node, anomaly detection, report page); modernize |

## 3. Root-cause fix: upgrade breakage

**Problem reported:** bumping the plugin version frequently breaks the plugin on
upgrade; a full uninstall + reinstall is required to recover.

**Root cause (confirmed in code):** `better-sqlite3` is a native (C++) addon compiled
against a specific Node ABI. `lib/metrics-store.js:2` does a top-level
`require('better-sqlite3')`, and `performance-monitor.js:2` requires that module at
top level — **outside** the `openOrDegrade()` try/catch. When Node-RED (and thus
Node.js) is upgraded, the previously compiled binary no longer matches the new ABI,
the `require` throws at load time, and the **entire plugin fails to load** (sidebar
disappears). Uninstall + reinstall fixes it only because npm recompiles the addon.

**Fix:** Replace `better-sqlite3` with Node's built-in `node:sqlite`. It ships with
the Node runtime NR5 mandates (≥ 22.9; flag-free since 22.13), so there is **no native
compilation and no ABI to mismatch** — upgrades can never break on this axis.
Additionally, all storage access goes behind a `Storage` interface with a guaranteed
in-memory fallback, so even an unexpected storage failure degrades gracefully instead
of crashing the plugin load.

### Storage abstraction

```
lib/storage/
  index.js          → createStorage(opts): picks SqliteStorage, else MemoryStorage
  sqlite-storage.js → node:sqlite implementation (DatabaseSync)
  memory-storage.js → bounded in-memory ring buffer (degraded mode)
  schema.js         → shared schema + idempotent migration runner
```

- `index.js` attempts `require('node:sqlite')` inside try/catch. If unavailable
  (e.g. Node 22.9–22.12 without the flag, or a locked-down runtime) it returns
  `MemoryStorage` and logs a single clear warning. The plugin **always loads**.
- `MetricsStore`'s current public methods (`flush`, `getRecent`, `getRange`,
  `getSummary`, `getTopNodes`, `getNodeStats`, `getEvents`, alarm-rule CRUD,
  `runRetention`, `pruneOldestFraction`) are preserved as the storage interface so
  `MetricsCollector`, `AnomalyDetector`, and `http-routes` are unchanged.

### node:sqlite porting notes

`node:sqlite` API is close to `better-sqlite3` but differs in three places the
adapter must handle:

- `new DatabaseSync(path)` instead of `new Database(path)`.
- No `db.pragma(...)` helper → use `db.exec('PRAGMA journal_mode = WAL')` etc.
- No `db.transaction(fn)` helper → wrap with explicit `BEGIN`/`COMMIT`/`ROLLBACK`
  in a small `tx(fn)` utility.
- `prepare().get()/.all()/.run()` and `@named` parameters work the same way.

Existing migrations (`001-initial`, `002-alarm-rules`) use plain `db.exec(sql)` and
port unchanged. The migration runner stays idempotent (`schema_version` in `meta`).

**Data migration:** on first v3 start, if a legacy `performance-monitor.db` written by
better-sqlite3 exists, it is opened directly by `node:sqlite` (same on-disk SQLite
format) — history is preserved. WAL sidecar files are handled by opening in WAL mode.

## 4. Editor architecture (build pipeline)

### Source layout

```
src/editor/
  index.js            → entry: registers sidebar tab + header HUD, wires modules
  theme.js            → maps Node-RED CSS variables → component styles (no themes)
  sidebar/
    sidebar.js        → builds + updates the dense sidebar
    metric-row.js     → one compact metric row (label, value, bar, sparkline, expand)
    sections.js       → section definitions + ordering
  hud/
    header-widget.js  → top-header compact HUD (NR5-aware injection)
  charts/
    sparkline.js      → inline SVG sparkline
  format.js           → formatBytes, formatUptime, status classes
  api.js              → fetch wrappers for /performance-monitor/* admin routes
  styles.css          → all CSS, using var(--red-ui-*) tokens only
```

### Build

- `esbuild` bundles `src/editor/index.js` (+ inlined `styles.css`) and wraps the
  output in the small HTML shell Node-RED loads, producing the single
  `performance-monitor.html` at the package root (the file NR5 serves).
- Scripts: `build`, `build:watch`, `lint`, `format`, `test`.
- `prepublishOnly` runs `build` + `test` so the published artifact is always current.
- Built `performance-monitor.html` is committed (so `npm install` from git works
  without a build), and CI verifies it is up to date with source.

The report page (`lib/report-page.html`) and flow-node editor
(`nodes/perf-monitor-node/perf-monitor-node.html`) are smaller; they get the same
CSS-variable theming treatment but may stay single-file initially (YAGNI) unless the
editor module split naturally absorbs them.

## 5. Compact sidebar redesign

**Principle:** every metric is a single dense **row**; detail is opt-in via expand.
Collapsed, the whole monitor fits without scrolling in a typical sidebar height
(~280–320px vs the current ~700px).

### Metric row (collapsed, default)

```
[icon] Label                         value
       ▁▂▃▅▇  (thin 2px fill bar / inline micro-sparkline, ~16px)
```

- One row ≈ 22–28px tall (vs ~80–120px cards today).
- Left: small icon + label (NR token font sizes).
- Right: live value, color-coded by status (ok/warn/crit via NR semantic vars).
- Background/foot: a 2px fill bar for percentage metrics; a faint inline sparkline
  for trend metrics. Both use NR accent variables.

### Section grouping

- Tight section headers (11px small-caps, ~4px padding) with a collapse chevron.
- Sections preserved: **Application** (PID, uptime, heap/RSS, external, array
  buffers), **CPU**, **Memory**, **Event Loop**, **System** (CPU/RAM/Disk),
  **Host**. Detail fields move into the expanded state of their row.

### Expanded row (click)

- Reveals full sparkline (taller), sub-values (e.g. Heap used/total, RSS), and any
  per-metric history. Only one section's detail need be open at a time.

### Theming

- A single stylesheet referencing only `var(--red-ui-*)` tokens. NR5's built-in dark
  theme and OS preference switching then "just work" — no custom theme engine, no
  cyberpunk/matrix/funky. The four old themes and all `hudThemes` code are removed.

### Accessibility (NR5 raised the bar)

- Rows are real buttons with `aria-expanded`; section toggles have `aria-controls`;
  live values use `aria-live="polite"`; icons are `aria-hidden`. Keyboard focusable.

## 6. Header HUD widget

The compact top-header widget is kept but rebuilt to be NR5-aware:

- Inject into NR5's header DOM defensively (feature-detect the mount point; if the
  expected node is absent, no-op rather than throw). **Requires live NR5 DOM
  verification** — flagged as a verification task in the plan.
- Single style set from NR variables; remove per-theme HUD styling.
- Toggle to hide remains in settings.

## 7. HTTP API & server modules

- Public admin routes under `/performance-monitor/*` are **unchanged** (stats,
  recent, range, summary, stream, settings, report, alarm-rules CRUD), so any
  external consumers keep working.
- `metrics-collector`, `anomaly-detector`, `container-detect` keep their behavior;
  only their dependency (`store`) is now the storage interface.
- Existing XSS hardening and threshold validation are preserved.

## 8. Repo & package hygiene

- **Remove committed runtime artifacts:** `performance-monitor.db` (and any
  `-wal`/`-shm`); add to `.gitignore`. Verify it's not in the published tarball.
- **`files` allowlist + `.npmignore`:** publish only runtime code, built
  `performance-monitor.html`, `lib/`, `nodes/`, `LICENSE`, `README.md`, `CHANGELOG.md`.
  Exclude `docs/`, `test/`, `src/`, screenshots, `.superpowers/`, the `.db`.
- **Screenshots:** keep README hero images but ensure they're excluded from the npm
  tarball; refresh to show the new compact UI.
- **`package.json`:** bump to `3.0.0`; `engines.node` `>=22.9.0`;
  `node-red.version` `>=4.0.0` (functions on 5; document 5 as target); remove
  `better-sqlite3` dependency; add esbuild/eslint/prettier to devDependencies.
- **README:** restructure — concise value prop, screenshot of compact UI,
  install, configuration table, HTTP API reference, compatibility matrix, badges
  (npm version, CI, license). Drop the four-theme gallery.
- **CHANGELOG:** add a proper `3.0.0` entry (breaking: dropped themes, dropped
  better-sqlite3, min Node 22.9) following Keep a Changelog.
- **CI (`.github/workflows`):** run lint + test + `build` (and assert built HTML is
  in sync) on Node 22 and 24; keep the existing npm-publish workflow, gated on CI.

## 9. Testing strategy

- Keep and adapt the existing mocha suite. The storage tests retarget the new
  `node:sqlite` adapter; add a `MemoryStorage` fallback test and a test that a
  failed storage init still loads the plugin (degraded mode).
- Add a migration test that opens a legacy better-sqlite3-format DB with the new
  adapter and reads existing rows (data-preservation guarantee).
- Editor modules (`format`, `sparkline`, `metric-row` pure logic) get unit tests
  runnable in Node without a browser.
- **Live verification (manual / browser-driven):** install the built package into a
  real Node-RED 5 instance and confirm: sidebar renders compact, light/dark follow
  NR theme, header HUD injects correctly, expand/collapse works, accessibility. This
  is a plan checkpoint, not an automated test.

## 10. Out of scope (YAGNI)

- No new metrics or features beyond what exists today.
- No multi-language/i18n.
- No rewrite of the report page's internal charting beyond CSS-variable theming.
- No TypeScript migration (esbuild bundling of modular JS is the agreed bar).

## 11. Risks & verifications

| Risk | Mitigation |
|---|---|
| NR5 header DOM differs from assumptions | Feature-detect mount point; verify on live NR5 before finalizing HUD |
| `node:sqlite` flag on Node 22.9–22.12 | Detect at load, fall back to MemoryStorage + warn |
| Legacy DB read incompatibility | Migration test against a real legacy DB file |
| Built HTML drifts from source | CI asserts `build` output matches committed file |
| Sidebar split/drag (NR5) interactions | Verify tab behaves under split-sidebar on live NR5 |

## 12. Deliverable

A single `v3.0.0` release: compact NR5-native sidebar, native-dependency-free
storage that survives upgrades, modular built editor source, clean repo and
published package, refreshed docs, green CI.
