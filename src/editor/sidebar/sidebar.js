'use strict';
const { SECTIONS } = require('./sections');
const { metricRow } = require('./metric-row');
const { getStats } = require('../api');

function buildSidebar() {
  const root = document.createElement('div');
  root.className = 'pm-sidebar';

  // Store interval ID and rows for update loop
  let pollingInterval = null;
  let isPaused = false;
  const rows = []; // Array of { section, row }
  const externalUpdaters = []; // Array of update functions from external consumers (HUD, etc)

  // ===== Toolbar =====
  const toolbar = document.createElement('div');
  toolbar.className = 'pm-toolbar';

  // Status indicator (ONLINE/OFFLINE)
  const statusEl = document.createElement('div');
  statusEl.className = 'pm-status pm-status-online';
  const statusDot = document.createElement('span');
  statusDot.className = 'pm-status-dot';
  const statusLabel = document.createElement('span');
  statusLabel.className = 'pm-status-label';
  statusLabel.textContent = 'ONLINE';
  statusEl.appendChild(statusDot);
  statusEl.appendChild(statusLabel);
  toolbar.appendChild(statusEl);

  // Spacer
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  toolbar.appendChild(spacer);

  // Pause button
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'pm-toolbar-btn';
  pauseBtn.setAttribute('title', 'Pause polling');
  pauseBtn.innerHTML = '<i class="fa fa-pause"></i>';
  pauseBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    pauseBtn.classList.toggle('pm-paused', isPaused);
    pauseBtn.setAttribute('title', isPaused ? 'Resume polling' : 'Pause polling');
  });
  toolbar.appendChild(pauseBtn);

  // Refresh button
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'pm-toolbar-btn';
  refreshBtn.setAttribute('title', 'Force refresh');
  refreshBtn.innerHTML = '<i class="fa fa-refresh"></i>';
  refreshBtn.addEventListener('click', () => {
    // Force one immediate poll
    getStats()
      .then((stats) => {
        rows.forEach(({ row }) => row.update(stats));
        externalUpdaters.forEach(fn => fn(stats));
        statusEl.className = 'pm-status pm-status-online';
        statusLabel.textContent = 'ONLINE';
      })
      .catch((err) => {
        console.error('Refresh failed:', err);
        statusEl.className = 'pm-status pm-status-offline';
        statusLabel.textContent = 'OFFLINE';
      });
  });
  toolbar.appendChild(refreshBtn);

  // Settings button (stub for now)
  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'pm-toolbar-btn';
  settingsBtn.setAttribute('title', 'Settings');
  settingsBtn.innerHTML = '<i class="fa fa-cog"></i>';
  settingsBtn.addEventListener('click', () => {
    // Stub: placeholder for Task 8 (settings panel)
    console.log('Settings button clicked (not yet implemented)');
  });
  toolbar.appendChild(settingsBtn);

  root.appendChild(toolbar);

  // ===== Groups =====
  // Application group
  const appGroupLabel = document.createElement('div');
  appGroupLabel.className = 'pm-group-head';
  appGroupLabel.textContent = 'Application';
  root.appendChild(appGroupLabel);

  const appSection = document.createElement('div');
  appSection.className = 'pm-group';
  SECTIONS.filter((s) => s.group === 'app').forEach((section) => {
    const { el, update } = metricRow(section);
    appSection.appendChild(el);
    rows.push({ section, row: { update } });
  });
  root.appendChild(appSection);

  // System group
  const sysGroupLabel = document.createElement('div');
  sysGroupLabel.className = 'pm-group-head';
  sysGroupLabel.textContent = 'System';
  root.appendChild(sysGroupLabel);

  const sysSection = document.createElement('div');
  sysSection.className = 'pm-group';
  SECTIONS.filter((s) => s.group === 'sys').forEach((section) => {
    const { el, update } = metricRow(section);
    sysSection.appendChild(el);
    rows.push({ section, row: { update } });
  });
  root.appendChild(sysSection);

  // ===== Polling & control =====
  function start(interval = 2000) {
    if (pollingInterval) return; // Already running

    function poll() {
      if (isPaused) return; // Skip if paused

      getStats()
        .then((stats) => {
          rows.forEach(({ row }) => row.update(stats));
          externalUpdaters.forEach(fn => fn(stats));
          statusEl.className = 'pm-status pm-status-online';
          statusLabel.textContent = 'ONLINE';
        })
        .catch((err) => {
          console.error('Poll failed:', err);
          // Keep last values, just mark offline
          statusEl.className = 'pm-status pm-status-offline';
          statusLabel.textContent = 'OFFLINE';
        });
    }

    // Initial poll
    poll();

    // Schedule recurring polls
    pollingInterval = setInterval(poll, interval);
  }

  function stop() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  function restartPolling(newInterval) {
    stop();
    start(newInterval);
  }

  function registerExternalUpdater(fn) {
    externalUpdaters.push(fn);
  }

  return {
    el: root,
    start,
    stop,
    restartPolling,
    registerExternalUpdater,
  };
}

module.exports = { buildSidebar };
