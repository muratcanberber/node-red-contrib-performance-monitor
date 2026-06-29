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
