# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-06-30

The Node-RED 5 release: rebuilt UI, native-dependency-free storage, and a much
cleaner package.

### Added
- **Compact sidebar** — every metric is a dense single-line row with an inline
  status bar; click a row to expand history, sub-values, and a sparkline.
- **Animated header HUD** — CPU / RSS / event-loop lag / session-peak memory with
  lightweight CSS-transition bar fills (no animation loop, no extra CPU cost).
- **Modular editor source** built with esbuild (`src/editor/` → bundled
  `performance-monitor.html`); unit-tested pure-logic modules.
- Native (Node-RED inherited) theming that follows the editor's light/dark theme
  automatically.

### Changed
- **Storage migrated from `better-sqlite3` to Node's built-in `node:sqlite`** — no
  native compilation, so installs are reliable on Alpine/ARM/containers and survive
  Node upgrades. Falls back to in-memory history if SQLite is unavailable.
- Minimum runtime is now **Node.js 22.9** (Node-RED 5 baseline); built and verified
  for Node-RED 5.
- Published package now ships only runtime files (`files` allowlist).

### Removed
- The four bundled themes (Classic/Funky/Matrix/Cyberpunk) and the theme/HUD-size
  pickers — replaced by a single Node-RED-native look.
- The `better-sqlite3` dependency.

### Fixed
- **Plugin no longer breaks on upgrade** — the previous native-module load failure on
  a Node version change (which forced an uninstall/reinstall) is eliminated.
- Flow node `perf-monitor` is now registered once (resolves the Node-RED 5
  `perf-monitor already registered` warning).
- Settings panel now toggles correctly from the toolbar gear.

## [2.0.0] - 2026-04-14

### Added
- SQLite-backed metrics persistence (`performance-monitor.db` in Node-RED user dir).
- Per-node instrumentation via `RED.hooks` (msg count, avg process time, errors).
- Live SSE stream at `GET /performance-monitor/stream`.
- Historical query endpoints (`/recent`, `/range`, `/summary`).
- Retention + max-DB-size controls in settings UI.
- Deploy/stop lifecycle markers recorded for future anomaly analysis.

### Changed
- **BREAKING**: now requires Node-RED ≥ 1.1.0 (hooks API).
- **BREAKING**: drops "zero native dependencies" claim — adds `better-sqlite3` (ships prebuilt binaries).
- Code reorganized into `lib/` modules (internal change).

### Migration
- First launch post-upgrade creates a fresh `performance-monitor.db`. No user action required.

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
