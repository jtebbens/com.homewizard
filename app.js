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

// Helper: log current heap in MB via v8 (process.memoryUsage rss fails on Homey sandbox)
function logMem(label) {
  try {
    const hs = v8.getHeapStatistics();
    const heap = (hs.used_heap_size    / 1024 / 1024).toFixed(1);
    const total = (hs.total_heap_size  / 1024 / 1024).toFixed(1);
    const ext  = (hs.external_memory   / 1024 / 1024).toFixed(1);
    console.log(`[MEM] ${label}: heap=${heap}/${total}MB ext=${ext}MB`);
  } catch (e) {
    console.log(`[MEM] ${label}: unavailable (${e.message})`);
  }
}

class HomeWizardApp extends Homey.App {
  async onInit() {
    this.log('HomeWizard app ready!');
    this.baseloadMonitor = null;
    this.p1Source = null;

    // 🔍 CRASH DIAGNOSTICS: Global error handlers
    this._setupGlobalErrorHandlers();

    // 🔍 MEMORY DIAGNOSTICS: Log heap every 5s for first 3 minutes
    // This helps identify which device/engine causes memory ceiling on startup
    let _memCount = 0;
    logMem('app-start');
    this._memInterval = setInterval(() => {
      _memCount++;
      logMem(`T+${_memCount * 5}s`);
      if (_memCount >= 36) { // 3 minutes
        clearInterval(this._memInterval);
        this._memInterval = null;
        console.log('[MEM] Memory monitor stopped after 3 minutes');
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
