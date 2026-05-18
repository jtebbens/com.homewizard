'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');

const BASE    = 'https://api.dataplatform.knmi.nl/open-data/v1';
const DATASET = '10-minute-in-situ-meteorological-observations';
const VERSION = '1.0';

let _h5wasmFile = null;

async function _getFileClass() {
  if (_h5wasmFile) return _h5wasmFile;
  const mod = await import('h5wasm/node');
  await mod.ready;
  _h5wasmFile = mod.File;
  return _h5wasmFile;
}

async function _fetchLatestFilename(apiKey) {
  const url = `${BASE}/datasets/${DATASET}/versions/${VERSION}/files?maxKeys=1&orderBy=created&sorting=desc`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: apiKey } }, 10000);
  if (!res.ok) throw new Error(`KNMI list error ${res.status}`);
  const data = await res.json();
  const file = data.files?.[0];
  if (!file) throw new Error('KNMI: no files');
  return file.filename;
}

async function _downloadBuffer(apiKey, filename) {
  const urlRes = await fetchWithTimeout(
    `${BASE}/datasets/${DATASET}/versions/${VERSION}/files/${filename}/url`,
    { headers: { Authorization: apiKey } }, 10000
  );
  if (!urlRes.ok) throw new Error(`KNMI url error ${urlRes.status}`);
  const { temporaryDownloadUrl } = await urlRes.json();
  const fileRes = await fetchWithTimeout(temporaryDownloadUrl, {}, 30000);
  if (!fileRes.ok) throw new Error(`KNMI download error ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

/**
 * Fetch global solar radiation (qg, W/m²) from nearest KNMI automatic station.
 * Returns null if API key missing or on any error.
 * @param {string} apiKey  KNMI Data Platform API key
 * @param {number} userLat
 * @param {number} userLon
 * @returns {Promise<{qg:number, stationName:string, distKm:number}|null>}
 */
async function fetchKnmiRadiation(apiKey, userLat, userLon) {
  if (!apiKey || typeof userLat !== 'number' || typeof userLon !== 'number') return null;

  const filename = await _fetchLatestFilename(apiKey);
  const buf      = await _downloadBuffer(apiKey, filename);

  const File = await _getFileClass();

  // Write to temp path on real FS — h5wasm/node reads from filesystem
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');
  const tmp  = path.join(os.tmpdir(), `knmi_${Date.now()}.nc`);
  fs.writeFileSync(tmp, buf);

  try {
    const f       = new File(tmp, 'r');
    const latV    = f.get('lat').value;
    const lonV    = f.get('lon').value;
    const qgMeta  = f.get('qg');
    const qgV     = qgMeta.value;
    const stride  = qgMeta.shape[1];

    const nameV = f.get('stationname').value;

    let best = 0, bestD = Infinity;
    for (let i = 0; i < latV.length; i++) {
      const d = Math.hypot(latV[i] - userLat, lonV[i] - userLon);
      if (d < bestD) { bestD = d; best = i; }
    }

    const qg = qgV[best * stride];
    const stationName = String(nameV[best] ?? '').trim();
    const distKm = bestD * 111; // rough deg → km

    f.close();
    return { qg: isFinite(qg) ? qg : null, stationName, distKm: Math.round(distKm) };
  } finally {
    try { require('fs').unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { fetchKnmiRadiation };
