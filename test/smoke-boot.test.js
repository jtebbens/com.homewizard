'use strict';

/*
 * Smoke boot test: requires app.js plus every driver, device and lib module
 * under a Homey-sandbox emulation, so syntax errors, broken requires and
 * top-level use of sandbox-blocked APIs fail here instead of in production.
 * (v3.15.110 was dead on arrival: process.memoryUsage() throws
 * "ENOENT uv_resident_set_memory" inside the Homey sandbox.)
 */

const Module = require('module');
const fs = require('fs');
const path = require('path');

// --- Homey sandbox emulation ---------------------------------------------
// eslint-disable-next-line no-restricted-properties -- deliberately replaced to emulate the sandbox
process.memoryUsage = () => {
  const e = new Error('ENOENT: no such file or directory, uv_resident_set_memory');
  e.code = 'ENOENT';
  throw e;
};

// --- homey module stub -----------------------------------------------------
class SimpleClass {
  on() { return this; }

  emit() { return true; }
}
const homeyStub = {
  App: class App extends SimpleClass {},
  Driver: class Driver extends SimpleClass {},
  Device: class Device extends SimpleClass {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'homey') return homeyStub;
  return origLoad.call(this, request, parent, isMain);
};

// --- collect targets --------------------------------------------------------
const root = path.join(__dirname, '..');
const targets = [path.join(root, 'app.js')];
for (const drv of fs.readdirSync(path.join(root, 'drivers'))) {
  for (const f of ['driver.js', 'device.js']) {
    const p = path.join(root, 'drivers', drv, f);
    if (fs.existsSync(p)) targets.push(p);
  }
}
for (const f of fs.readdirSync(path.join(root, 'lib'))) {
  if (f.endsWith('.js')) targets.push(path.join(root, 'lib', f));
}

let failures = 0;
for (const file of targets) {
  try {
    require(file);
  } catch (e) {
    failures++;
    console.error(`FAIL ${path.relative(root, file)}: ${e.message}`);
  }
}

console.log(`smoke-boot: ${targets.length - failures}/${targets.length} modules loaded`);
process.exit(failures ? 1 : 0);
