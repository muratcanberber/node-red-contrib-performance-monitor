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
