'use strict';
const { statusClass, lagStatusClass } = require('../format');
const { sparkline } = require('../sparkline');
const RingBuffer = require('../ring-buffer');

function metricRow(section) {
  const detailId = `${section.id}-detail`;
  const ringBuffer = new RingBuffer(120); // Store sparkline points

  // Create the row container
  const el = document.createElement('div');
  el.className = 'pm-row';

  // Create the header button
  const head = document.createElement('button');
  head.className = 'pm-row-head';
  head.setAttribute('aria-expanded', 'false');
  head.setAttribute('aria-controls', detailId);

  // Icon
  const icon = document.createElement('i');
  icon.className = `fa ${section.icon}`;
  icon.setAttribute('aria-hidden', 'true');
  head.appendChild(icon);

  // Label
  const label = document.createElement('span');
  label.className = 'pm-label';
  label.textContent = section.label;
  head.appendChild(label);

  // Value
  const value = document.createElement('span');
  value.className = 'pm-value';
  value.textContent = '—';
  head.appendChild(value);

  el.appendChild(head);

  // Create the fill bar (status indicator)
  const fill = document.createElement('div');
  fill.className = 'pm-fill';
  el.appendChild(fill);

  // Create the detail panel
  const detail = document.createElement('div');
  detail.className = 'pm-detail';
  detail.id = detailId;

  // Create detail content container (will be populated on update)
  const detailContent = document.createElement('div');
  detailContent.className = 'pm-detail-content';
  detail.appendChild(detailContent);

  el.appendChild(detail);

  // Toggle detail on head click
  head.addEventListener('click', () => {
    const isOpen = el.classList.contains('pm-open');
    if (isOpen) {
      el.classList.remove('pm-open');
      head.setAttribute('aria-expanded', 'false');
    } else {
      el.classList.add('pm-open');
      head.setAttribute('aria-expanded', 'true');
    }
  });

  // Update function
  function update(stats) {
    // Update the value text
    const newValue = section.value(stats);
    value.textContent = newValue;

    // Update fill bar if section has a percent
    const pct = section.percent(stats);
    if (pct !== null && pct !== undefined) {
      // For event loop lag, use lagStatusClass; otherwise use statusClass
      let statusCls;
      if (section.id === 'app-lag') {
        const lagMs = stats.nodeRed.eventLoopLag || 0;
        statusCls = lagStatusClass(lagMs);
        ringBuffer.push(lagMs);
      } else {
        statusCls = statusClass(pct);
        ringBuffer.push(pct);
      }

      // Clamp percentage to 0-100
      const clampedPct = Math.max(0, Math.min(100, pct));
      fill.style.width = `${clampedPct}%`;

      // Remove all status classes and add the new one
      fill.classList.remove('pm-ok', 'pm-warn', 'pm-crit');
      fill.classList.add(statusCls);
    } else {
      // No percent; hide the fill bar
      fill.style.width = '0%';
      fill.classList.remove('pm-ok', 'pm-warn', 'pm-crit');
    }

    // Update detail panel
    const detailRows = section.detail(stats);
    detailContent.innerHTML = '';

    if (detailRows && detailRows.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'pm-detail-grid';

      detailRows.forEach((row) => {
        const labelEl = document.createElement('div');
        labelEl.className = 'pm-detail-label';
        labelEl.textContent = row.label;
        grid.appendChild(labelEl);

        const valueEl = document.createElement('div');
        valueEl.className = 'pm-detail-value';
        valueEl.textContent = row.value;
        grid.appendChild(valueEl);
      });

      detailContent.appendChild(grid);
    }

    // Update sparkline if section has a sparkKey
    if (section.sparkKey && ringBuffer.values().length > 0) {
      const svg = sparkline(ringBuffer.values(), { width: 100, height: 16 });
      const sparkContainer = document.createElement('div');
      sparkContainer.className = 'pm-sparkline-container';
      sparkContainer.innerHTML = svg;
      detailContent.appendChild(sparkContainer);
    }
  }

  return { el, update };
}

module.exports = { metricRow };
