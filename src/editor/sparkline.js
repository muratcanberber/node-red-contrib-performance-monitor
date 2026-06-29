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
