import css from './styles.css';
import { buildSidebar } from './sidebar/sidebar';

(function () {
  'use strict';
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const { el: sidebarEl, start, stop } = buildSidebar();

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

  // Start polling immediately; it will run as long as the page is open.
  // Note: RED.sidebar.addTab does not expose a visibility change API in Node-RED 5,
  // so we keep polling continuously. This is the simplest working approach.
  start();

  // Optional: if the tab object later exposes onchange/onshow, we can wire it here.
  // For now, polling runs continuously (acceptable for a monitoring tool).
})();
