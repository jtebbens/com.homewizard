'use strict';

const Homey = require('homey');
// const v8 = require('v8');

const Testing = false;

class HomeWizardApp extends Homey.App {
  onInit() {
    this.log('HomeWizard app ready!');
    this.baseloadMonitor = null;
    this.p1Source = null;

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
