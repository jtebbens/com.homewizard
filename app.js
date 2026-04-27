/*
 * HomeWizard App for Homey
 * Copyright (C) 2025 Jeroen Tebbens
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

'use strict';

const Homey = require('homey');
const v8 = require('v8');

const Testing = false;

// Helper: log V8 heap + (if available) process RSS. Memory Warning Limit on Homey
// could be RSS-based rather than heap — try both so we can correlate which bucket
// is actually growing.
function logMem(label) {
  try {
    const hs = v8.getHeapStatistics();
    const heap  = (hs.used_heap_size   / 1024 / 1024).toFixed(1);
    const total = (hs.total_heap_size  / 1024 / 1024).toFixed(1);
    const ext   = (hs.external_memory  / 1024 / 1024).toFixed(1);
    let rssPart = '';
    try {
      const mu = process.memoryUsage();
      const rss = (mu.rss / 1024 / 1024).toFixed(1);
      const ab  = (mu.arrayBuffers / 1024 / 1024).toFixed(1);
      rssPart = ` rss=${rss}MB ab=${ab}MB`;
    } catch (_) { /* sandbox blocks rss */ }
    console.log(`[MEM] ${label}: heap=${heap}/${total}MB ext=${ext}MB${rssPart}`);
  } catch (e) {
    console.log(`[MEM] ${label}: unavailable (${e.message})`);
  }
}

// Global device counter — each driver bumps on onInit so the runtime log shows
// which driver-types contribute how many instances. Useful for triaging crashes
// from users whose device mix differs from ours (e.g. the other user has 2×
// plugin_battery, we don't).
const _deviceCounts = {};
function bumpDeviceCount(driverId) {
  _deviceCounts[driverId] = (_deviceCounts[driverId] || 0) + 1;
}
function logDeviceCounts() {
  const entries = Object.entries(_deviceCounts);
  if (entries.length === 0) return;
  const summary = entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[MEM] devices: ${summary}`);
}

class HomeWizardApp extends Homey.App {
  // Exposed for drivers: this.homey.app.logMem('my-driver:event-name')
  logMem(label) { logMem(label); }
  bumpDeviceCount(driverId) { bumpDeviceCount(driverId); }

  async onInit() {
    this.log('HomeWizard app ready!');
    this.baseloadMonitor = null;
    this.p1Source = null;

    // 🔍 CRASH DIAGNOSTICS: Global error handlers
    this._setupGlobalErrorHandlers();

    // 🔍 MEMORY DIAGNOSTICS: Log heap every 5s for first 3 minutes (startup cascade),
    // then every 60s indefinitely (runtime tracking — needed because reported crashes
    // happen 5–20 minutes into runtime, well after the original 3-min monitor stopped).
    let _memCount = 0;
    logMem('app-start');
    this._memInterval = setInterval(() => {
      _memCount++;
      logMem(`T+${_memCount * 5}s`);
      if (_memCount >= 36) { // 3 minutes — switch to low-frequency runtime monitor
        clearInterval(this._memInterval);
        console.log('[MEM] Startup monitor stopped — switching to 60s runtime monitor');
        let _runtimeCount = 0;
        this._memInterval = setInterval(() => {
          _runtimeCount++;
          logMem(`run+${_runtimeCount}min`);
          if (_runtimeCount === 1 || _runtimeCount % 10 === 0) logDeviceCounts();
        }, 60_000);
      }
    }, 5000);

      if (process.env.DEBUG === '1' && Testing) {
        try {
          require('inspector').waitForDebugger();
        }
        catch (error) {
          require('inspector').open(9225, '0.0.0.0', true);
      }
    }

    // On version change: remove orphaned settings keys left by deleted devices.
    // Deferred 30s so all drivers and devices have finished initializing.
    const currentVersion = require('./app.json').version;
    const lastVersion = this.homey.settings.get('_hw_app_version');
    if (lastVersion !== currentVersion) {
      this.log(`[MIGRATE] Version change: ${lastVersion || 'new install'} → ${currentVersion}`);
      setTimeout(() => this._runSettingsMigration(currentVersion), 30_000);
    }
  }

  _runSettingsMigration(currentVersion) {
    try {
      const driver = this.homey.drivers.getDriver('battery-policy');
      const activeIds = new Set(driver.getDevices().map(d => d.getData().id));
      if (typeof this.homey.settings.getAll !== 'function') return;
      const all = this.homey.settings.getAll();
      let removed = 0;
      for (const key of Object.keys(all)) {
        if (key.startsWith('batt_mode_hist_')) {
          const id = key.replace('batt_mode_hist_', '');
          if (!activeIds.has(id)) {
            try { this.homey.settings.unset(key); removed++; } catch (_) {}
          }
        }
      }
      if (removed > 0) this.log(`[MIGRATE] Removed ${removed} orphaned batt_mode_hist key(s)`);
    } catch (e) {
      this.error('[MIGRATE] Settings migration failed:', e.message);
    }
    try { this.homey.settings.set('_hw_app_version', currentVersion); } catch (_) {}
  }

  _setupGlobalErrorHandlers() {
    // Track unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('💥 UNHANDLED PROMISE REJECTION:');
      console.error('   Promise:', promise);
      console.error('   Reason:', reason?.stack || reason);
      
      // Log to Homey
      this.error('💥 Unhandled Promise Rejection:', reason?.stack || reason);
    });

    // Track uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error('💥 UNCAUGHT EXCEPTION:');
      console.error('   Error:', err?.stack || err);
      
      // Log to Homey
      this.error('💥 Uncaught Exception:', err?.stack || err);
    });

    // Track warning events (like MaxListenersExceededWarning)
    process.on('warning', (warning) => {
      console.warn('⚠️ PROCESS WARNING:', warning.name, warning.message);
      console.warn('   Stack:', warning.stack);
      
      this.log('⚠️ Warning:', warning.name, warning.message);
    });

    this.log('✅ Global error handlers installed');
  }

  async onUninit() {
    if (this._memInterval) {
      clearInterval(this._memInterval);
      this._memInterval = null;
    }
  }
  
}

module.exports = HomeWizardApp;
