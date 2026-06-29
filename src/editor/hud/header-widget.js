'use strict';
const { formatBytes } = require('../format');

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
    return createHudInterface(hudEl);
  }

  // Create HUD element
  hudEl = document.createElement('div');
  hudEl.id = 'pm-hud';
  hudEl.className = 'pm-hud';

  // Metrics container
  const metricsContainer = document.createElement('div');
  metricsContainer.className = 'pm-hud-metrics';

  // CPU metric
  const cpuMetric = document.createElement('div');
  cpuMetric.className = 'pm-hud-metric';
  const cpuLabel = document.createElement('span');
  cpuLabel.className = 'pm-hud-label';
  cpuLabel.textContent = 'CPU';
  const cpuValue = document.createElement('span');
  cpuValue.className = 'pm-hud-value';
  cpuValue.textContent = '—';
  cpuMetric.appendChild(cpuLabel);
  cpuMetric.appendChild(cpuValue);
  metricsContainer.appendChild(cpuMetric);

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'pm-hud-separator';
  metricsContainer.appendChild(sep1);

  // RSS metric
  const rssMetric = document.createElement('div');
  rssMetric.className = 'pm-hud-metric';
  const rssLabel = document.createElement('span');
  rssLabel.className = 'pm-hud-label';
  rssLabel.textContent = 'RSS';
  const rssValue = document.createElement('span');
  rssValue.className = 'pm-hud-value';
  rssValue.textContent = '—';
  rssMetric.appendChild(rssLabel);
  rssMetric.appendChild(rssValue);
  metricsContainer.appendChild(rssMetric);

  // Separator
  const sep2 = document.createElement('div');
  sep2.className = 'pm-hud-separator';
  metricsContainer.appendChild(sep2);

  // Lag metric
  const lagMetric = document.createElement('div');
  lagMetric.className = 'pm-hud-metric';
  const lagLabel = document.createElement('span');
  lagLabel.className = 'pm-hud-label';
  lagLabel.textContent = 'LAG';
  const lagValue = document.createElement('span');
  lagValue.className = 'pm-hud-value';
  lagValue.textContent = '—';
  lagMetric.appendChild(lagLabel);
  lagMetric.appendChild(lagValue);
  metricsContainer.appendChild(lagMetric);

  // Separator
  const sep3 = document.createElement('div');
  sep3.className = 'pm-hud-separator';
  metricsContainer.appendChild(sep3);

  // Peak RSS metric
  const peakMetric = document.createElement('div');
  peakMetric.className = 'pm-hud-metric';
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

  // Track peak RSS across updates
  let peakRss = 0;

  return {
    update(stats) {
      if (!stats) return;

      // CPU %
      const cpu = stats.nodeRed?.cpu?.percentage ?? 0;
      cpuValue.textContent = cpu.toFixed(1) + '%';

      // RSS in MB/GB
      const rss = stats.nodeRed?.memory?.rss ?? 0;
      rssValue.textContent = formatBytes(rss);

      // Track peak RSS
      if (rss > peakRss) {
        peakRss = rss;
      }
      peakValue.textContent = formatBytes(peakRss);

      // Event-loop lag in ms
      const lag = stats.nodeRed?.eventLoop?.lagMs ?? 0;
      lagValue.textContent = lag.toFixed(0) + ' ms';
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
  // Return interface for existing HUD element
  let peakRss = 0;

  return {
    update(stats) {
      if (!stats) return;

      const cpuValue = hudEl.querySelector('.pm-hud-metric:nth-child(1) .pm-hud-value');
      const rssValue = hudEl.querySelector('.pm-hud-metric:nth-child(3) .pm-hud-value');
      const lagValue = hudEl.querySelector('.pm-hud-metric:nth-child(5) .pm-hud-value');
      const peakValue = hudEl.querySelector('.pm-hud-metric:nth-child(7) .pm-hud-value');

      if (cpuValue) {
        const cpu = stats.nodeRed?.cpu?.percentage ?? 0;
        cpuValue.textContent = cpu.toFixed(1) + '%';
      }

      if (rssValue) {
        const rss = stats.nodeRed?.memory?.rss ?? 0;
        rssValue.textContent = formatBytes(rss);
        if (rss > peakRss) {
          peakRss = rss;
        }
      }

      if (peakValue) {
        peakValue.textContent = formatBytes(peakRss);
      }

      if (lagValue) {
        const lag = stats.nodeRed?.eventLoop?.lagMs ?? 0;
        lagValue.textContent = lag.toFixed(0) + ' ms';
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
