# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-06-30

The Node-RED 5 release. A major step over 1.2.0: persistent history, a flow node,
anomaly detection, and a fully rebuilt, compact, Node-RED-native UI — with **zero
runtime dependencies** and reliable upgrades.

### Added
- **SQLite-backed history** via Node's built-in `node:sqlite` — configurable retention
  and max-DB-size, with live SSE stream (`/stream`) and query endpoints (`/recent`,
  `/range`, `/summary`). Falls back to in-memory history if SQLite is unavailable.
- **`perf-monitor` flow node** to read metrics inside flows.
- **Anomaly detection** — built-in CPU spike / heap growth / event-loop block / traffic
  patterns, plus user-defined fixed and statistical alarm rules; full-screen historical
  report dashboard.
- Per-node instrumentation via `RED.hooks` (msg count, avg process time, errors).
- **Compact sidebar** — every metric is a dense single-line row with an inline status
  bar; click a row to expand history, sub-values, and a sparkline.
- **Animated header HUD** — CPU / RSS / event-loop lag / session-peak memory with
  lightweight CSS-transition bar fills (no animation loop, no extra CPU cost).
- **Modular editor source** built with esbuild (`src/editor/` → bundled
  `performance-monitor.html`); unit-tested pure-logic modules and CI on Node 22 & 24.

### Changed
- **BREAKING:** minimum runtime is now **Node.js 22.9** (Node-RED 5 baseline); built and
  verified for Node-RED 5.
- Native (Node-RED inherited) theming that follows the editor's light/dark theme
  automatically — no theme configuration needed.
- Published package ships only runtime files (`files` allowlist).

### Removed
- **BREAKING:** the four bundled themes (Classic/Funky/Matrix/Cyberpunk) and the
  theme/HUD-size pickers — replaced by a single Node-RED-native look.

### Fixed
- **No native dependencies, no upgrade breakage** — history uses built-in `node:sqlite`,
  so there is no compiled addon to mismatch when Node is upgraded (the previous
  `better-sqlite3` load failure that forced an uninstall/reinstall is eliminated).
- Flow node `perf-monitor` is now registered once (resolves the Node-RED 5
  `perf-monitor already registered` warning).
- Settings panel now toggles correctly from the toolbar gear.

### Migration from 1.2.0
- Requires Node.js ≥ 22.9 (Node-RED 5). History is created automatically on first start;
  an existing `performance-monitor.db` is read as-is. No user action required.

---

## [1.2.0] - 2026-02-06 - Docker Container Support

### 🐳 Container Compatibility

- **Cgroup v1/v2 Detection**: Automatically detects container memory and CPU limits
- **Container Memory**: Shows actual container RAM limit instead of host memory
- **Effective CPU Cores**: Calculates effective cores from CPU quota (e.g., 0.5 cores)
- **Container Indicator**: New `isContainerized` flag in metrics output
- **Dockerfile**: Added Dockerfile for testing in containerized environments

### 🧪 Testing

- Added 5 new tests for container/cgroup detection
- All 38 tests passing

Fixes #4

---

## [1.1.0] - 2026-01-23 - The Complete Overhaul

A massive update focusing on precision, cross-platform compatibility, and a modern, native UI experience.

### 🚀 Major Features

- **Zero Dependencies**: Removed `systeminformation`. Now uses native Node.js APIs (`process.cpuUsage`, `process.memoryUsage`, `fs.statfs`) for 100% cross-platform compatibility (macOS, Windows, Linux, Alpine, Raspberry Pi).
- **Native UI Integration**: Redesigned sidebar to inherit Node-RED's CSS variables. Automatically adapts to any theme (Light, Dark, Custom).
- **System Hardware Charts**: Real-time **Sparkline Charts** for:
  - System CPU Load
  - System RAM Usage
  - System Disk Usage
- **Compact "Mini Mode"**:
  - Minimized panes now show **Live Header Values** (e.g., "12%").
  - Content hides completely to save space.
  - Strict conditional display avoids data duplication.
- **Event Loop Lag Meter**: Precise lag monitoring with color-coded thresholds (<10ms Green, >50ms Red).

### 🎨 Visual Polish

- **Icons**: Added intuitive icons for every metric (Microchip, Server, HDD, Bolt).
- **Streamlined UI**: Removed simplified tooltips for a cleaner, more direct visual experience.
- **Progress Bars**: Thicker, clearer bars with "Used / Total" labels.
- **Header Widget**: Optional top-bar widget showing CPU/RAM summary (can be hidden in settings).

### 🔧 Technical Improvements

- **Precision CPU**: Moved from `os.loadavg` to diff-based process CPU usage.
- **Precision Memory**: Tracking `rss`, `heapTotal`, `heapUsed`, `external`, and `arrayBuffers`.
- **Performance**: Optimized frontend rendering with smart history array management (shifting).

### 🧪 Quality

- **100% Test Coverage**: Full Mocha/Sinon test suite mocking all system scenarios (Windows, Serverless, High Lag).

---

## [1.0.1] - Previous Release

- Initial public release
- Basic CPU/RAM monitoring
- `systeminformation` dependency
