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
