# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
