'use strict';
const { getSettings, saveSettings } = require('../api');

/**
 * Opens a settings panel inline in the sidebar.
 * Displays 4 form fields: Refresh interval (ms), History retention (days),
 * Max DB size (MB), and Hide header HUD (checkbox).
 * On save, validates, persists via api.saveSettings(), and applies live changes.
 *
 * @param {Object} opts - Options object
 * @param {Object} opts.current - Current settings from server
 * @param {Function} opts.onRestartPolling - Callback to restart poll timer with new interval
 * @param {Function} opts.onToggleHud - Callback to toggle HUD visibility (hideHud: boolean)
 * @returns {Object} { el: HTMLElement, close: Function }
 */
function openSettings(opts = {}) {
  const { current = {}, onRestartPolling, onToggleHud } = opts;

  // Create container (will be inserted into sidebar by caller)
  const panelEl = document.createElement('div');
  panelEl.className = 'pm-settings-panel';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'pm-settings-header';
  const titleEl = document.createElement('h3');
  titleEl.className = 'pm-settings-title';
  titleEl.textContent = 'Settings';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pm-settings-close';
  closeBtn.setAttribute('title', 'Close settings');
  closeBtn.innerHTML = '<i class="fa fa-times"></i>';
  headerEl.appendChild(titleEl);
  headerEl.appendChild(closeBtn);
  panelEl.appendChild(headerEl);

  // Form container
  const formEl = document.createElement('form');
  formEl.className = 'pm-settings-form';

  // ===== Refresh Interval =====
  const refreshFieldEl = document.createElement('div');
  refreshFieldEl.className = 'pm-settings-field';
  const refreshLabelEl = document.createElement('label');
  refreshLabelEl.className = 'pm-settings-label';
  refreshLabelEl.textContent = 'Refresh interval (ms)';
  const refreshInputEl = document.createElement('input');
  refreshInputEl.type = 'number';
  refreshInputEl.className = 'pm-settings-input';
  refreshInputEl.min = '500';
  refreshInputEl.max = '60000';
  refreshInputEl.value = current.refreshIntervalMs || 2000;
  refreshInputEl.setAttribute('title', 'Minimum 500ms');
  refreshFieldEl.appendChild(refreshLabelEl);
  refreshFieldEl.appendChild(refreshInputEl);
  formEl.appendChild(refreshFieldEl);

  // ===== History Retention =====
  const retentionFieldEl = document.createElement('div');
  retentionFieldEl.className = 'pm-settings-field';
  const retentionLabelEl = document.createElement('label');
  retentionLabelEl.className = 'pm-settings-label';
  retentionLabelEl.textContent = 'History retention (days)';
  const retentionInputEl = document.createElement('input');
  retentionInputEl.type = 'number';
  retentionInputEl.className = 'pm-settings-input';
  retentionInputEl.min = '1';
  retentionInputEl.max = '365';
  retentionInputEl.value = current.retentionDays || 30;
  retentionInputEl.setAttribute('title', 'Minimum 1 day');
  retentionFieldEl.appendChild(retentionLabelEl);
  retentionFieldEl.appendChild(retentionInputEl);
  formEl.appendChild(retentionFieldEl);

  // ===== Max DB Size =====
  const maxDbFieldEl = document.createElement('div');
  maxDbFieldEl.className = 'pm-settings-field';
  const maxDbLabelEl = document.createElement('label');
  maxDbLabelEl.className = 'pm-settings-label';
  maxDbLabelEl.textContent = 'Max DB size (MB)';
  const maxDbInputEl = document.createElement('input');
  maxDbInputEl.type = 'number';
  maxDbInputEl.className = 'pm-settings-input';
  maxDbInputEl.min = '10';
  maxDbInputEl.max = '10000';
  maxDbInputEl.value = current.maxDbSizeMB || 100;
  maxDbInputEl.setAttribute('title', 'Minimum 10 MB');
  maxDbFieldEl.appendChild(maxDbLabelEl);
  maxDbFieldEl.appendChild(maxDbInputEl);
  formEl.appendChild(maxDbFieldEl);

  // ===== Hide HUD Checkbox =====
  const hudFieldEl = document.createElement('div');
  hudFieldEl.className = 'pm-settings-field pm-settings-checkbox-field';
  const hudCheckboxEl = document.createElement('input');
  hudCheckboxEl.type = 'checkbox';
  hudCheckboxEl.className = 'pm-settings-checkbox';
  hudCheckboxEl.id = 'pm-settings-hide-hud';
  hudCheckboxEl.checked = current.hideHud || false;
  const hudLabelEl = document.createElement('label');
  hudLabelEl.htmlFor = 'pm-settings-hide-hud';
  hudLabelEl.className = 'pm-settings-checkbox-label';
  hudLabelEl.textContent = 'Hide header HUD';
  hudFieldEl.appendChild(hudCheckboxEl);
  hudFieldEl.appendChild(hudLabelEl);
  formEl.appendChild(hudFieldEl);

  // ===== Buttons =====
  const buttonContainerEl = document.createElement('div');
  buttonContainerEl.className = 'pm-settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'pm-settings-btn pm-settings-btn-save';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'pm-settings-btn pm-settings-btn-cancel';
  cancelBtn.textContent = 'Cancel';

  buttonContainerEl.appendChild(saveBtn);
  buttonContainerEl.appendChild(cancelBtn);
  formEl.appendChild(buttonContainerEl);

  panelEl.appendChild(formEl);

  // Close function (removes panel and optionally fires callbacks)
  const close = () => {
    if (panelEl.parentElement) {
      panelEl.parentElement.removeChild(panelEl);
    }
  };

  // Save handler
  saveBtn.addEventListener('click', (e) => {
    e.preventDefault();

    // Validate inputs
    const refreshMs = parseInt(refreshInputEl.value, 10);
    const retentionDays = parseInt(retentionInputEl.value, 10);
    const maxDbMb = parseInt(maxDbInputEl.value, 10);
    const hideHud = hudCheckboxEl.checked;

    if (!Number.isInteger(refreshMs) || refreshMs < 500) {
      alert('Refresh interval must be at least 500ms');
      refreshInputEl.focus();
      return;
    }

    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      alert('History retention must be at least 1 day');
      retentionInputEl.focus();
      return;
    }

    if (!Number.isInteger(maxDbMb) || maxDbMb < 10) {
      alert('Max DB size must be at least 10 MB');
      maxDbInputEl.focus();
      return;
    }

    // Build new settings object
    const newSettings = {
      refreshIntervalMs: refreshMs,
      retentionDays: retentionDays,
      maxDbSizeMB: maxDbMb,
      hideHud: hideHud,
    };

    // Save via API
    saveSettings(newSettings)
      .then(() => {
        // Live apply: restart polling with new interval
        if (onRestartPolling && refreshMs !== current.refreshIntervalMs) {
          onRestartPolling(refreshMs);
        }

        // Live apply: toggle HUD visibility
        if (onToggleHud && hideHud !== current.hideHud) {
          onToggleHud(!hideHud); // setVisible expects true to show, false to hide
        }

        // Close panel
        close();
      })
      .catch((err) => {
        console.error('Failed to save settings:', err);
        alert('Failed to save settings: ' + err.message);
      });
  });

  // Cancel handler
  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });

  // Close button handler
  closeBtn.addEventListener('click', () => {
    close();
  });

  return { el: panelEl, close };
}

module.exports = { openSettings };
