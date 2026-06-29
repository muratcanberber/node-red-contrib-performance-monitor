import css from './styles.css';
import { buildSidebar } from './sidebar/sidebar';
import { initHud } from './hud/header-widget';
import { getSettings } from './api';
import { openSettings } from './sidebar/settings';

(function () {
  'use strict';
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const { el: sidebarEl, start, stop, restartPolling, registerExternalUpdater } = buildSidebar();

  RED.plugins.registerPlugin('performance-monitor', {
    type: 'performance-monitor',
    onadd() { /* no-op */ },
  });

  const tab = RED.sidebar.addTab({
    id: 'performance-monitor',
    name: 'Performance Monitor',
    iconClass: 'fa fa-tachometer',
    content: sidebarEl,
  });

  // Initialize HUD and register it as an external updater
  // This feeds the HUD from the same poll loop as the sidebar
  const hud = initHud();
  registerExternalUpdater((stats) => hud.update(stats));

  // Wire settings button via exposed settingsBtn in sidebar DOM
  // Find the settings button in the toolbar and attach click handler
  const settingsBtn = sidebarEl.querySelector('.pm-toolbar-btn:last-child');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      try {
        const currentSettings = await getSettings();
        const { el: panelEl } = openSettings({
          current: currentSettings,
          onRestartPolling: (newInterval) => {
            restartPolling(newInterval);
          },
          onToggleHud: (show) => {
            hud.setVisible(show);
          },
        });
        sidebarEl.insertBefore(panelEl, sidebarEl.querySelector('.pm-group-head'));
      } catch (err) {
        console.error('Failed to open settings:', err);
        alert('Failed to load settings: ' + err.message);
      }
    });
  }

  // Start polling immediately; it will run as long as the page is open.
  // Note: RED.sidebar.addTab does not expose a visibility change API in Node-RED 5,
  // so we keep polling continuously. This is the simplest working approach.
  start();

  // Optional: if the tab object later exposes onchange/onshow, we can wire it here.
  // For now, polling runs continuously (acceptable for a monitoring tool).
})();
