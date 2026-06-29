# Editor Rebuild (esbuild + compact NR5 sidebar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1433-line monolithic `performance-monitor.html` with modular `src/editor/` source bundled by esbuild into that single file, redesigned as a compact, single-theme, NR5-native sidebar that inherits Node-RED's CSS variables (light/dark automatic).

**Architecture:** `src/editor/index.js` is the entry; esbuild bundles it (+ inlined CSS) and wraps the output in the small `<script>` shell Node-RED loads, emitting `performance-monitor.html` at the package root. Pure-logic modules (format, sparkline) are unit-tested in Node. UI modules (sidebar, metric-row, hud, settings) are verified by building and loading into the live Node-RED 5 instance and screenshotting.

**Tech Stack:** esbuild (bundler), vanilla JS (no framework), Node-RED 5 editor APIs (`RED.sidebar.addTab`, `RED.plugins.registerPlugin`, `RED.notify`, `$.ajax`), mocha for pure-logic tests.

## Global Constraints

- Target: Node-RED **5.0** (Node ≥ 22.9). The editor must inherit NR theme via `var(--red-ui-*)` tokens ONLY — no hardcoded colors, no theme engine. NR5's built-in dark mode and OS-preference switching must then work automatically.
- **Single shipped editor file:** Node-RED loads exactly one `performance-monitor.html` for this plugin. esbuild produces it from `src/editor/`. The built file IS committed (so `npm install` from git works without a build).
- **Removed entirely:** the 4 themes (`classic`/`funky`/`matrix`/`neon` in `hudThemes`), the theme selector in settings, `applyHudTheme`, per-theme styling, and `hudSize`-driven theming. One coherent look only.
- **Preserved behavior:** the sidebar polls `GET /performance-monitor/stats` (shape below), the header HUD widget (toggleable in settings), Pause, Settings, retention/refresh settings, the section set (Application: info/cpu/memory/lag; System: cpu/memory/disk/host).
- **Compactness target:** collapsed default state fits Application CPU + Memory + Event Loop + System CPU/RAM/Disk visible without scrolling in a ~600px sidebar height. A metric row is ~24–28px tall (today's cards are ~80–120px).
- **Accessibility:** expandable rows are `<button>`s with `aria-expanded`/`aria-controls`; live values use `aria-live="polite"`; decorative icons `aria-hidden="true"`; keyboard focusable.
- **Stats shape (from `/performance-monitor/stats`)**, verified live:
  `{ nodeRed: { cpu:Number, memory:{ rss, heapUsed, heapTotal, external, arrayBuffers }, eventLoopLag:Number, pid:Number, uptime:Number }, system: { cpu:{ percent, cores, model }, memory:{ total, used, free, usedPercent }, disk:{ total, used, free, usedPercent } } }`
- Test runner: `npx mocha` must stay green and pristine after each task.
- Do NOT bump package `version`, change `files`/`.npmignore`, README, or CHANGELOG (Plan 3 scope). Adding esbuild to devDependencies and `build` scripts IS in scope.

## Live verification harness (already running)

A Node-RED 5.0.0 instance runs at `http://127.0.0.1:1899` with this package installed into its userDir. After a `build`, copy the built `performance-monitor.html` into the installed package and restart NR (or reinstall) to see changes. The controller drives screenshots via the preview/browser tools; visual tasks below specify the screenshot acceptance check.

## File Structure

```
src/editor/
  index.js          entry: RED.sidebar.addTab + HUD init + RED.plugins.registerPlugin('performance-monitor', …)
  api.js            ajax wrappers: getStats(), getSettings(), saveSettings()
  format.js         formatBytes, formatUptime, statusClass(pct), lagStatusClass(ms)
  sparkline.js      sparkline(points, opts) -> inline SVG string
  ring-buffer.js    fixed-length history buffer (push/values)
  theme.js          (thin) maps semantic status -> NR var names; NO theme engine
  sidebar/
    sidebar.js      builds container, runs poll loop, dispatches row updates
    sections.js     ordered section + metric definitions (id, label, icon, group, accessor)
    metric-row.js   one compact row: label, live value, fill bar, micro-sparkline, expand
    settings.js     settings panel (refresh, retention, maxDb, hide HUD) — NO theme picker
  hud/
    header-widget.js NR5-aware header HUD inject + update; single style
  styles.css        all CSS, var(--red-ui-*) only
build/
  build.mjs         esbuild bundle + HTML-shell wrap -> performance-monitor.html
```

The report page (`lib/report-page.html`) and flow-node editor HTML are out of scope here (Plan 3 may retheme them).

---

### Task 1: esbuild pipeline producing the loadable HTML

Stand up the build so `npm run build` bundles `src/editor/index.js` + `styles.css` into the single `performance-monitor.html` Node-RED loads, and the tab renders (empty placeholder) in the live NR5. Everything else builds on this.

**Files:**
- Create: `build/build.mjs`, `src/editor/index.js`, `src/editor/styles.css`
- Modify: `package.json` (devDependency `esbuild`; scripts `build`, `build:watch`)
- Generate (committed): `performance-monitor.html`

**Interfaces:**
- Produces: `npm run build` → writes `performance-monitor.html`. `index.js` calls `RED.sidebar.addTab({ id:'performance-monitor', name:'Performance Monitor', iconClass:'fa fa-tachometer', content })` and `RED.plugins.registerPlugin('performance-monitor', { type:'performance-monitor', onadd(){} })`.

- [ ] **Step 1: Add esbuild and scripts to package.json**

Add to `devDependencies`: `"esbuild": "^0.24.0"`. Add to `scripts`:
```json
"build": "node build/build.mjs",
"build:watch": "node build/build.mjs --watch"
```
Run `npm install --cache ./.npmcache --no-audit --no-fund` (or the repo's normal install) to fetch esbuild.

- [ ] **Step 2: Write the build script**

```javascript
// build/build.mjs
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_HTML = join(root, 'performance-monitor.html');

async function run() {
  const result = await build({
    entryPoints: [join(root, 'src/editor/index.js')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    loader: { '.css': 'text' },
    write: false,
    logLevel: 'info',
  });
  const js = result.outputFiles[0].text;
  // Node-RED loads the plugin .html into the editor; wrap the bundle in a script tag.
  const html = `<!-- Performance Monitor — built from src/editor/ by build/build.mjs. DO NOT EDIT BY HAND. -->\n<script type="text/javascript">\n${js}\n</script>\n`;
  await writeFile(OUT_HTML, html, 'utf8');
  console.log('wrote', OUT_HTML, js.length, 'bytes JS');
}
run().catch((e) => { console.error(e); process.exit(1); });
```
(CSS is imported as a string in `index.js` via `import css from './styles.css'` and injected at runtime into a `<style>` element — keeps one bundle.)

- [ ] **Step 3: Write a minimal entry + empty stylesheet**

```javascript
// src/editor/index.js
import css from './styles.css';

(function () {
  'use strict';
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  function content() {
    const el = document.createElement('div');
    el.className = 'pm-root';
    el.textContent = 'Performance Monitor';
    return el;
  }

  RED.plugins.registerPlugin('performance-monitor', {
    type: 'performance-monitor',
    onadd() { /* no-op */ },
  });

  RED.sidebar.addTab({
    id: 'performance-monitor',
    name: 'Performance Monitor',
    iconClass: 'fa fa-tachometer',
    content: content(),
  });
})();
```
```css
/* src/editor/styles.css */
.pm-root { padding: 8px; color: var(--red-ui-primary-text-color, #333); font-size: 12px; }
```

- [ ] **Step 4: Build and verify output exists**

Run: `npm run build`
Expected: prints `wrote …/performance-monitor.html`; the file begins with the generated-file banner and contains one `<script>` with the bundled IIFE (no `import` statements remain).

- [ ] **Step 5: Verify it loads in live NR5 (controller-driven)**

Copy built file into the running instance's installed package and restart NR; open the Performance Monitor sidebar tab. Acceptance: the tab shows "Performance Monitor" placeholder with no console errors. (If the controller runs this, it screenshots; if the implementer cannot reach the browser, it reports the build artifact and the controller verifies.)

- [ ] **Step 6: Commit**

```bash
git add build/build.mjs src/editor/index.js src/editor/styles.css package.json package-lock.json performance-monitor.html
git commit -m "build(editor): esbuild pipeline emitting performance-monitor.html from src/editor"
```

---

### Task 2: format helpers (TDD, pure logic)

Extract the formatting/threshold helpers as a standalone tested module.

**Files:**
- Create: `src/editor/format.js`, `test/editor-format.test.js`

**Interfaces:**
- Produces: `formatBytes(bytes, decimals=1)`, `formatUptime(seconds)`, `statusClass(pct)` → `'pm-ok'|'pm-warn'|'pm-crit'`, `lagStatusClass(ms)` → same set. Exported via `module.exports` AND usable from the bundle (esbuild handles CJS in the bundle; tests require it directly).

- [ ] **Step 1: Write the failing test**

```javascript
// test/editor-format.test.js
const assert = require('assert');
const { formatBytes, formatUptime, statusClass, lagStatusClass } = require('../src/editor/format');

describe('editor/format', function () {
  it('formatBytes', function () {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(1024), '1 KB');
    assert.strictEqual(formatBytes(1536, 1), '1.5 KB');
    assert.strictEqual(formatBytes(1048576), '1 MB');
  });
  it('formatUptime', function () {
    assert.strictEqual(formatUptime(30), '0m');
    assert.strictEqual(formatUptime(3600), '1h 0m');
    assert.strictEqual(formatUptime(90061), '1d 1h 1m');
  });
  it('statusClass thresholds', function () {
    assert.strictEqual(statusClass(10), 'pm-ok');
    assert.strictEqual(statusClass(75), 'pm-warn');
    assert.strictEqual(statusClass(95), 'pm-crit');
  });
  it('lagStatusClass thresholds', function () {
    assert.strictEqual(lagStatusClass(5), 'pm-ok');
    assert.strictEqual(lagStatusClass(30), 'pm-warn');
    assert.strictEqual(lagStatusClass(80), 'pm-crit');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx mocha test/editor-format.test.js`
Expected: FAIL — `Cannot find module '../src/editor/format'`.

- [ ] **Step 3: Implement**

```javascript
// src/editor/format.js
'use strict';
function formatBytes(bytes, decimals = 1) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function statusClass(pct) { return pct < 70 ? 'pm-ok' : pct < 90 ? 'pm-warn' : 'pm-crit'; }
function lagStatusClass(ms) { return ms < 10 ? 'pm-ok' : ms < 50 ? 'pm-warn' : 'pm-crit'; }
module.exports = { formatBytes, formatUptime, statusClass, lagStatusClass };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx mocha test/editor-format.test.js`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/editor/format.js test/editor-format.test.js
git commit -m "feat(editor): tested format/threshold helpers"
```

---

### Task 3: sparkline + ring-buffer (TDD, pure logic)

**Files:**
- Create: `src/editor/sparkline.js`, `src/editor/ring-buffer.js`, `test/editor-sparkline.test.js`

**Interfaces:**
- Produces: `sparkline(points, { width=120, height=18, colorVar='--red-ui-text-color-link' }) → string` (SVG markup with a single `<polyline>`, no axes — micro style). `RingBuffer(size)` with `.push(v)` (drops oldest past `size`) and `.values()` → array length ≤ size.

- [ ] **Step 1: Write the failing test**

```javascript
// test/editor-sparkline.test.js
const assert = require('assert');
const { sparkline } = require('../src/editor/sparkline');
const RingBuffer = require('../src/editor/ring-buffer');

describe('editor/sparkline', function () {
  it('returns an svg with a polyline sized to opts', function () {
    const svg = sparkline([0, 1, 2, 3], { width: 100, height: 20 });
    assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
    assert.match(svg, /width="100"/);
    assert.match(svg, /<polyline/);
  });
  it('handles empty / single point without throwing', function () {
    assert.doesNotThrow(() => sparkline([], {}));
    assert.doesNotThrow(() => sparkline([5], {}));
  });
});
describe('editor/ring-buffer', function () {
  it('keeps only the last N values', function () {
    const rb = new RingBuffer(3);
    [1, 2, 3, 4, 5].forEach((v) => rb.push(v));
    assert.deepStrictEqual(rb.values(), [3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx mocha test/editor-sparkline.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```javascript
// src/editor/ring-buffer.js
'use strict';
class RingBuffer {
  constructor(size) { this._size = size; this._buf = []; }
  push(v) { this._buf.push(v); if (this._buf.length > this._size) this._buf.shift(); }
  values() { return this._buf.slice(); }
}
module.exports = RingBuffer;
```
```javascript
// src/editor/sparkline.js
'use strict';
function sparkline(points, opts = {}) {
  const width = opts.width || 120;
  const height = opts.height || 18;
  const colorVar = opts.colorVar || '--red-ui-text-color-link';
  if (!points || points.length === 0) {
    return `<svg width="${width}" height="${height}" class="pm-spark" aria-hidden="true"></svg>`;
  }
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const pts = points.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`).join(' ');
  return `<svg width="${width}" height="${height}" class="pm-spark" aria-hidden="true" preserveAspectRatio="none">` +
    `<polyline points="${pts}" fill="none" stroke="var(${colorVar})" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
module.exports = { sparkline };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx mocha test/editor-sparkline.test.js`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/editor/sparkline.js src/editor/ring-buffer.js test/editor-sparkline.test.js
git commit -m "feat(editor): tested sparkline + ring-buffer"
```

---

### Task 4: api wrappers + section definitions

**Files:**
- Create: `src/editor/api.js`, `src/editor/sidebar/sections.js`, `test/editor-sections.test.js`

**Interfaces:**
- `api.getStats()` → Promise resolving the stats object (uses `$.ajax`/`fetch` to `RED.settings.apiRootUrl`-aware admin path). `api.getSettings()`, `api.saveSettings(obj)`.
- `sections.js` exports `SECTIONS`: an ordered array of `{ id, group:'app'|'sys', label, icon, value(stats)->string, percent(stats)->Number|null, sparkKey, detail(stats)->[{label,value}] }`. This is the single source of layout truth consumed by the sidebar.

- [ ] **Step 1: Write the failing test (sections are pure data + accessors)**

```javascript
// test/editor-sections.test.js
const assert = require('assert');
const { SECTIONS } = require('../src/editor/sidebar/sections');
const sample = {
  nodeRed: { cpu: 12.5, memory: { rss: 100, heapUsed: 50, heapTotal: 80, external: 4, arrayBuffers: 1 }, eventLoopLag: 2.0, pid: 1, uptime: 3600 },
  system: { cpu: { percent: 40, cores: 8, model: 'x' }, memory: { total: 100, used: 60, free: 40, usedPercent: 60 }, disk: { total: 100, used: 30, free: 70, usedPercent: 30 } },
};
describe('editor/sections', function () {
  it('defines app + sys sections in order', function () {
    const ids = SECTIONS.map((s) => s.id);
    assert.ok(ids.includes('app-cpu') && ids.includes('app-memory') && ids.includes('app-lag'));
    assert.ok(ids.includes('sys-cpu') && ids.includes('sys-memory') && ids.includes('sys-disk'));
  });
  it('accessors compute values from stats', function () {
    const cpu = SECTIONS.find((s) => s.id === 'app-cpu');
    assert.strictEqual(cpu.percent(sample), 12.5);
    assert.match(cpu.value(sample), /12\.5/);
    const sysMem = SECTIONS.find((s) => s.id === 'sys-memory');
    assert.strictEqual(sysMem.percent(sample), 60);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx mocha test/editor-sections.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sections.js` and `api.js`**

Implement `SECTIONS` using `format.js` helpers for `value`/`detail`, with `percent` returning the numeric percent (or `null` for non-percent rows like host info). `app-cpu.percent = s => s.nodeRed.cpu`; `app-memory.percent = s => s.nodeRed.memory.heapUsed / s.nodeRed.memory.heapTotal * 100`; `sys-cpu.percent = s => s.system.cpu.percent`; `sys-memory.percent = s => s.system.memory.usedPercent`; `sys-disk.percent = s => s.system.disk.usedPercent`; `app-lag.percent = () => null` (uses `lagStatusClass` on the ms value instead). `detail` returns the sub-rows currently shown in expanded cards (heap used/total, RSS, external, array buffers; cores/model; total/free; PID/uptime/platform).

```javascript
// src/editor/api.js
'use strict';
function admin(path) { return (RED.settings.apiRootUrl || '') + path; }
function getJSON(path) {
  return new Promise((resolve, reject) => {
    $.ajax({ url: admin(path), dataType: 'json', success: resolve, error: (xhr) => reject(new Error('HTTP ' + xhr.status)) });
  });
}
function getStats() { return getJSON('performance-monitor/stats'); }
function getSettings() { return getJSON('performance-monitor/settings'); }
function saveSettings(obj) {
  return new Promise((resolve, reject) => {
    $.ajax({ url: admin('performance-monitor/settings'), method: 'POST', contentType: 'application/json', data: JSON.stringify(obj), success: resolve, error: (xhr) => reject(new Error('HTTP ' + xhr.status)) });
  });
}
module.exports = { getStats, getSettings, saveSettings };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx mocha test/editor-sections.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/editor/api.js src/editor/sidebar/sections.js test/editor-sections.test.js
git commit -m "feat(editor): api wrappers + tested section definitions"
```

---

### Task 5: compact metric row + sidebar styles (visual)

Build the dense row component and the compact stylesheet (NR variables only). Verified by build + live NR5 screenshot.

**Files:**
- Create: `src/editor/sidebar/metric-row.js`
- Modify: `src/editor/styles.css`

**Interfaces:**
- `metricRow(section)` → `{ el, update(stats) }`. `el` is a `<div class="pm-row">` containing a header `<button class="pm-row-head" aria-expanded="false" aria-controls="…">` (icon + label + live value + fill-bar) and a hidden detail panel (sub-values + full sparkline). `update(stats)` sets the value text, fill-bar width + status class, pushes to the row's RingBuffer, and refreshes the sparkline.

- [ ] **Step 1: Implement `metric-row.js`**

A row builds: `[icon] label … value` on the head, a 2px `.pm-fill` bar absolutely positioned at the row foot whose width = `percent` and class = `statusClass(percent)`, and a collapsed `.pm-detail` (sub-values grid + `sparkline(...)`). Clicking the head toggles `aria-expanded` and a `.pm-open` class. Use `format.js`, `sparkline.js`, `ring-buffer.js`.

- [ ] **Step 2: Write compact CSS (var(--red-ui-*) only)**

Key rules (no hardcoded colors): `.pm-row-head { display:flex; align-items:center; gap:6px; height:26px; padding:0 8px; background:none; border:0; width:100%; cursor:pointer; color:var(--red-ui-primary-text-color); font-size:12px; }` · `.pm-row-head .pm-label { flex:1; text-align:left; color:var(--red-ui-secondary-text-color); }` · `.pm-row-head .pm-value { font-variant-numeric:tabular-nums; }` · `.pm-fill { height:2px; background:var(--red-ui-text-color-link); }` · `.pm-ok{background:var(--red-ui-text-color-success,#3a3)} .pm-warn{background:var(--red-ui-secondary-border-color)} .pm-crit{background:var(--red-ui-text-color-error,#c33)}` · `.pm-detail{display:none;padding:4px 8px 8px 24px} .pm-open .pm-detail{display:block}` · section headers `.pm-group-head{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--red-ui-tertiary-text-color);padding:6px 8px 2px}`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `performance-monitor.html` regenerated, no esbuild errors.

- [ ] **Step 4: Live NR5 acceptance (controller-driven screenshot)**

Render a few rows (the controller wires them via Task 6, or a temporary harness). Acceptance criteria for the screenshot: rows are ~24–28px tall; label/value on one line; a thin status-colored bar under percentage rows; clicking a row expands detail; colors match NR theme (switch NR to dark — text/bars must invert via variables, no hardcoded light colors).

- [ ] **Step 5: Commit**

```bash
git add src/editor/sidebar/metric-row.js src/editor/styles.css performance-monitor.html
git commit -m "feat(editor): compact metric row + NR-variable styles"
```

---

### Task 6: sidebar assembly + poll loop (visual)

Assemble sections into the sidebar, wire the toolbar (Settings / Pause / refresh / ONLINE), and run the polling loop against `api.getStats()`.

**Files:**
- Create: `src/editor/sidebar/sidebar.js`
- Modify: `src/editor/index.js` (use `buildSidebar()` for the tab content)

**Interfaces:**
- `buildSidebar()` → `{ el, start(), stop() }`. `el` contains a toolbar, an Application group, and a System group, each populated from `SECTIONS` via `metricRow`. `start()` begins polling at the configured interval (default 2000ms); `stop()` clears it. Pause toggles polling; refresh forces one `getStats()`; ONLINE/OFFLINE reflects last fetch success.

- [ ] **Step 1: Implement `sidebar.js`** — build groups from `SECTIONS.filter(group==='app')` and `'sys'`, store `{section, row}` map, on each poll call `row.update(stats)`. Handle fetch error → set OFFLINE, keep last values.
- [ ] **Step 2: Wire `index.js`** to use `buildSidebar()`; call `start()` on tab show, `stop()` on hide if available.
- [ ] **Step 3: Build** — `npm run build` (no errors).
- [ ] **Step 4: Live NR5 acceptance** — sidebar shows all sections compactly, values update every 2s, Pause halts updates, refresh forces one, the whole monitor (Application + System) fits with far less scroll than baseline. Controller screenshots and compares against the baseline.
- [ ] **Step 5: Commit**

```bash
git add src/editor/sidebar/sidebar.js src/editor/index.js performance-monitor.html
git commit -m "feat(editor): compact sidebar assembly + poll loop"
```

---

### Task 7: NR5-aware header HUD widget (visual)

Rebuild the top-header HUD with a single NR-variable style and defensive NR5 injection.

**Files:**
- Create: `src/editor/hud/header-widget.js`
- Modify: `src/editor/index.js` (init HUD), `src/editor/styles.css`

**Interfaces:**
- `initHud({ getLast })` → `{ update(stats), setVisible(bool), destroy() }`. Injects a compact widget into the NR5 header; feature-detect the mount point (`#red-ui-header` / the header toolbar) and **no-op without throwing** if absent. Shows cpu%, RSS, lag, peak RSS. Style from `var(--red-ui-*)` only.

- [ ] **Step 1: Implement `header-widget.js`** — query the NR5 header container; if found, append a `.pm-hud` element; `update()` writes the four metrics; `setVisible` toggles display per the `hideHud` setting. Verified-live note: on NR5 the header mount is the element holding the deploy/menu group — confirm the selector against the live DOM and fall back gracefully.
- [ ] **Step 2: Wire into `index.js`**, gated by the `hideHud` setting; feed it from the same poll loop as the sidebar.
- [ ] **Step 3: Build** — `npm run build`.
- [ ] **Step 4: Live NR5 acceptance** — HUD appears in the NR5 header, values update, hides when the setting is off, and visually matches NR chrome in both light and dark. Controller screenshots.
- [ ] **Step 5: Commit**

```bash
git add src/editor/hud/header-widget.js src/editor/index.js src/editor/styles.css performance-monitor.html
git commit -m "feat(editor): NR5-aware header HUD with single NR-variable style"
```

---

### Task 8: settings panel (no theme picker)

**Files:**
- Create: `src/editor/sidebar/settings.js`
- Modify: `src/editor/index.js` (Settings button opens it)

**Interfaces:**
- `openSettings({ current, onSave })` shows a panel with: Refresh interval, History retention (days), Max DB size (MB), Hide HUD (checkbox). NO theme selector, NO HUD-size selector. `onSave` receives the new settings and persists via `api.saveSettings`.

- [ ] **Step 1: Implement `settings.js`** as a simple form rendered into the sidebar (or `RED.editor`/dialog). Validate numeric fields; on save call `api.saveSettings` and apply (restart poll timer, toggle HUD).
- [ ] **Step 2: Wire the Settings button** in the toolbar to `openSettings`.
- [ ] **Step 3: Build** — `npm run build`.
- [ ] **Step 4: Live NR5 acceptance** — Settings opens, changing refresh interval changes poll cadence, toggling Hide HUD shows/hides the header widget, no theme controls present. Controller screenshots.
- [ ] **Step 5: Commit**

```bash
git add src/editor/sidebar/settings.js src/editor/index.js performance-monitor.html
git commit -m "feat(editor): settings panel without theme/size pickers"
```

---

### Task 9: remove legacy monolith remnants + fix double node registration

Delete any dead code path from the old inline HTML now that the bundle is authoritative, and fix the flow-node double-registration warning observed live (`Error: perf-monitor already registered`).

**Files:**
- Modify: `performance-monitor.js` (remove the manual `require('./nodes/perf-monitor-node/...')(RED)` OR the `node-red.nodes` entry in `package.json` — keep exactly one registration path)
- Verify: no stray references to `hudThemes` / old function names remain in shipped files.

**Interfaces:**
- Consumes: live NR log. Produces: NR5 starts with a single registration and no "already registered" warning.

- [ ] **Step 1: Decide the single registration path** — `package.json`'s `node-red.nodes.perf-monitor` already registers the node type; the manual `require(...)(RED)` in `performance-monitor.js:30` double-registers. Remove the manual require (and the `RED._store`/`RED._collector` handoff if the node instead reads them another way) OR, if the node depends on that handoff, remove the `node-red.nodes` entry and keep the manual require. Pick the path that keeps the flow node functional.
- [ ] **Step 2: Restart NR5 and confirm the log** — `grep -i "already registered\|perf-monitor" nr.log` shows the plugin loads with NO "already registered" warning.
- [ ] **Step 3: Run the full server test suite** — `npx mocha` stays green (the node + integration tests still pass).
- [ ] **Step 4: Commit**

```bash
git add performance-monitor.js package.json
git commit -m "fix: register perf-monitor flow node once (resolves NR5 'already registered' warning)"
```

---

### Task 10: final live verification pass

Whole-feature verification on the live NR5 instance.

**Files:** none (verification only; capture screenshots).

- [ ] **Step 1:** Build (`npm run build`), reinstall/refresh into the live NR5, hard-reload the editor.
- [ ] **Step 2:** Verify and screenshot each acceptance: (a) compact sidebar — all sections visible with minimal scroll; (b) expand/collapse a row; (c) values update live; (d) toggle NR dark mode — everything follows via variables; (e) header HUD present + correct; (f) settings (no theme picker) changes behavior; (g) NR log clean (no "already registered", node:sqlite warning is the only expected line).
- [ ] **Step 3:** Confirm `npx mocha` green and `npm run build` clean. No commit unless a fix was needed.

---

## Self-Review

**Spec coverage (design §4–6, §11):** build pipeline → Task 1; pure-logic modules → Tasks 2–3; api + sections → Task 4; compact row + NR-variable styling (single theme, light/dark) → Task 5; sidebar assembly + poll → Task 6; NR5-aware HUD → Task 7; settings without theme picker → Task 8; remove themes/monolith → Tasks 5/8/9; double-registration bug (found live) → Task 9; live NR5 verification (header injection, split-sidebar, a11y, dark mode) → Tasks 5–10. ✓

**Placeholder scan:** Pure-logic tasks (1–4) carry complete code and exact commands. Visual tasks (5–8) intentionally specify interfaces + CSS keys + screenshot acceptance criteria rather than pre-baking every pixel, because the look is tuned against the live NR5 instance — each still has a concrete build step, a named acceptance check, and a commit. This is a deliberate, documented adaptation for visual work, not a missing spec.

**Type consistency:** `formatBytes/formatUptime/statusClass/lagStatusClass` (Task 2) used by `sections.js` (Task 4) and `metric-row.js` (Task 5). `sparkline`/`RingBuffer` (Task 3) used by `metric-row.js` (Task 5). `SECTIONS` shape (Task 4) consumed by `metricRow` (Task 5) and `buildSidebar` (Task 6). `api.getStats/getSettings/saveSettings` (Task 4) used by `sidebar.js` (Task 6) and `settings.js` (Task 8). `initHud({getLast})` (Task 7) wired in `index.js`.

**Note on accessibility & NR5 specifics:** ARIA requirements live in Task 5 (rows) and are verified in Task 10; the NR5 header mount-point and split-sidebar behavior are explicitly live-verified (Tasks 7, 10) since they cannot be asserted from unit tests.
