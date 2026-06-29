'use strict';
const { formatBytes } = require('../format');

// Shared peakRss across all HUD instances
let globalPeakRss = 0;

function initHud() {
  // Feature-detect: check for NR5 header and mount point
  const header = document.getElementById('red-ui-header');
  if (!header) {
    console.warn('[pm-hud] NR5 header not found, HUD disabled');
    return { update: () => {}, setVisible: () => {}, destroy: () => {} };
  }

  const toolbar = document.getElementById('red-ui-header-toolbar');
  if (!toolbar) {
    console.warn('[pm-hud] NR5 header toolbar not found, HUD disabled');
    return { update: () => {}, setVisible: () => {}, destroy: () => {} };
  }

  // Idempotent: check if HUD already exists
  let hudEl = document.getElementById('pm-hud');
  if (hudEl) {
    // Restore peakRss from data attribute if it exists
    const peakRssData = hudEl.getAttribute('data-peak-rss');
    if (peakRssData) {
      globalPeakRss = parseInt(peakRssData, 10);
    }
    return createHudInterface(hudEl);
  }

  // Create HUD element
  hudEl = document.createElement('div');
  hudEl.id = 'pm-hud';
  hudEl.className = 'pm-hud';
  hudEl.setAttribute('data-peak-rss', String(globalPeakRss));

  // Metrics container
  const metricsContainer = document.createElement('div');
  metricsContainer.className = 'pm-hud-metrics';

  // Helper to create a metric with fill bar
  function createMetric(label, metric) {
    const metricEl = document.createElement('div');
    metricEl.className = 'pm-hud-metric';
    metricEl.setAttribute('data-metric', metric);
    const labelEl = document.createElement('span');
    labelEl.className = 'pm-hud-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'pm-hud-value';
    valueEl.textContent = '—';
    const fillEl = document.createElement('div');
    fillEl.className = 'pm-hud-fill';
    metricEl.appendChild(fillEl);
    metricEl.appendChild(labelEl);
    metricEl.appendChild(valueEl);
    return { el: metricEl, valueEl, fillEl };
  }

  // CPU metric
  const cpuMetric = createMetric('CPU', 'cpu');
  metricsContainer.appendChild(cpuMetric.el);

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'pm-hud-separator';
  metricsContainer.appendChild(sep1);

  // RSS metric
  const rssMetric = createMetric('RSS', 'rss');
  metricsContainer.appendChild(rssMetric.el);

  // Separator
  const sep2 = document.createElement('div');
  sep2.className = 'pm-hud-separator';
  metricsContainer.appendChild(sep2);

  // Lag metric
  const lagMetric = createMetric('LAG', 'lag');
  metricsContainer.appendChild(lagMetric.el);

  // Separator
  const sep3 = document.createElement('div');
  sep3.className = 'pm-hud-separator';
  metricsContainer.appendChild(sep3);

  // Peak RSS metric (no fill bar for peak since it is always 100%)
  const peakMetric = document.createElement('div');
  peakMetric.className = 'pm-hud-metric';
  peakMetric.setAttribute('data-metric', 'peak');
  const peakLabel = document.createElement('span');
  peakLabel.className = 'pm-hud-label';
  peakLabel.textContent = 'PEAK';
  const peakValue = document.createElement('span');
  peakValue.className = 'pm-hud-value';
  peakValue.textContent = '—';
  peakMetric.appendChild(peakLabel);
  peakMetric.appendChild(peakValue);
  metricsContainer.appendChild(peakMetric);

  hudEl.appendChild(metricsContainer);

  // Insert into header just before toolbar
  header.insertBefore(hudEl, toolbar);

  return {
    update(stats) {
      if (!stats) return;

      // CPU %
      const cpu = stats.nodeRed?.cpu?.percentage ?? 0;
      cpuMetric.valueEl.textContent = cpu.toFixed(1) + '%';
      const cpuFill = Math.min(cpu, 100);
      cpuMetric.fillEl.style.width = cpuFill + '%';

      // RSS in MB/GB
      const rss = stats.nodeRed?.memory?.rss ?? 0;
      rssMetric.valueEl.textContent = formatBytes(rss);

      // Track peak RSS (globally)
      if (rss > globalPeakRss) {
        globalPeakRss = rss;
        hudEl.setAttribute('data-peak-rss', String(globalPeakRss));
      }

      // RSS fill bar: rss / peak * 100
      const rssFill = globalPeakRss > 0 ? Math.min((rss / globalPeakRss) * 100, 100) : 0;
      rssMetric.fillEl.style.width = rssFill + '%';

      const peakValue = peakMetric.querySelector('.pm-hud-value');
      peakValue.textContent = formatBytes(globalPeakRss);

      // Event-loop lag in ms
      const lag = stats.nodeRed?.eventLoop?.lagMs ?? 0;
      lagMetric.valueEl.textContent = lag.toFixed(0) + ' ms';

      // Lag fill bar: lag / 50ms * 100 (50ms = full)
      const lagFill = Math.min((lag / 50) * 100, 100);
      lagMetric.fillEl.style.width = lagFill + '%';
    },

    setVisible(visible) {
      hudEl.style.display = visible ? '' : 'none';
    },

    destroy() {
      if (hudEl && hudEl.parentElement) {
        hudEl.parentElement.removeChild(hudEl);
      }
    },
  };
}

function createHudInterface(hudEl) {
  // Return interface for existing HUD element (reused on re-init)
  // Uses data-metric attributes to select elements reliably

  return {
    update(stats) {
      if (!stats) return;

      // Select elements by data-metric attribute
      const cpuMetricEl = hudEl.querySelector('[data-metric="cpu"]');
      const rssMetricEl = hudEl.querySelector('[data-metric="rss"]');
      const lagMetricEl = hudEl.querySelector('[data-metric="lag"]');
      const peakMetricEl = hudEl.querySelector('[data-metric="peak"]');

      // CPU %
      if (cpuMetricEl) {
        const cpuValue = cpuMetricEl.querySelector('.pm-hud-value');
        const cpuFill = cpuMetricEl.querySelector('.pm-hud-fill');
        const cpu = stats.nodeRed?.cpu?.percentage ?? 0;
        if (cpuValue) cpuValue.textContent = cpu.toFixed(1) + '%';
        if (cpuFill) cpuFill.style.width = Math.min(cpu, 100) + '%';
      }

      // RSS in MB/GB
      if (rssMetricEl) {
        const rssValue = rssMetricEl.querySelector('.pm-hud-value');
        const rssFill = rssMetricEl.querySelector('.pm-hud-fill');
        const rss = stats.nodeRed?.memory?.rss ?? 0;
        if (rssValue) rssValue.textContent = formatBytes(rss);

        // Track peak RSS globally
        if (rss > globalPeakRss) {
          globalPeakRss = rss;
          hudEl.setAttribute('data-peak-rss', String(globalPeakRss));
        }

        // RSS fill: rss / peak * 100
        if (rssFill) {
          const rssFillPct = globalPeakRss > 0 ? Math.min((rss / globalPeakRss) * 100, 100) : 0;
          rssFill.style.width = rssFillPct + '%';
        }
      }

      // Peak RSS
      if (peakMetricEl) {
        const peakValue = peakMetricEl.querySelector('.pm-hud-value');
        if (peakValue) peakValue.textContent = formatBytes(globalPeakRss);
      }

      // Event-loop lag in ms
      if (lagMetricEl) {
        const lagValue = lagMetricEl.querySelector('.pm-hud-value');
        const lagFill = lagMetricEl.querySelector('.pm-hud-fill');
        const lag = stats.nodeRed?.eventLoop?.lagMs ?? 0;
        if (lagValue) lagValue.textContent = lag.toFixed(0) + ' ms';
        if (lagFill) lagFill.style.width = Math.min((lag / 50) * 100, 100) + '%';
      }
    },

    setVisible(visible) {
      hudEl.style.display = visible ? '' : 'none';
    },

    destroy() {
      if (hudEl && hudEl.parentElement) {
        hudEl.parentElement.removeChild(hudEl);
      }
    },
  };
}

module.exports = { initHud };
