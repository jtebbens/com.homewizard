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

// const v8 = require('v8');

const Testing = false;

class HomeWizardApp extends Homey.App {
  async onInit() {
    this.log('HomeWizard app ready!');
    this.baseloadMonitor = null;
    this.p1Source = null;

     // Debug: fetchQueue stats elke 10 seconden 
     // setInterval(() => { const stats = fetchQueue.stats(); this.log('fetchQueue stats:', stats); }, 1000);

      if (process.env.DEBUG === '1' && Testing) {
        try { 
          require('inspector').waitForDebugger();
        }
        catch (error) {
          require('inspector').open(9225, '0.0.0.0', true);
      }
    
    // Only enable memory monitor when running locally (CLI dev mode)
    /* if (Homey.platform === 'local') {
      this._memInterval = setInterval(() => {
        try {
          const hs = v8.getHeapStatistics();
          const heapUsed = (hs.used_heap_size / 1024 / 1024).toFixed(1);
          const heapTotal = (hs.total_heap_size / 1024 / 1024).toFixed(1);
          const external = (hs.external_memory / 1024 / 1024).toFixed(1);

          this.log(
            `Memory(V8): HeapUsed=${heapUsed}MB HeapTotal=${heapTotal}MB External=${external}MB`
          );
        } catch (err) {
          this.error('Memory monitor failed:', err.message);
        }
      }, 60000);
    } */
    }
  }

  async onUninit() {
    if (this._memInterval) {
      clearInterval(this._memInterval);
      this._memInterval = null;
    }
  }
  
}

module.exports = HomeWizardApp;
