'use strict';

const https = require('https');

/**
 * Stateless chart-rendering helpers extracted from device.js.
 * Exposes:
 *   - Pure config builders: buildPlanningChartConfig, buildPvChartConfig, buildModeChartBody
 *   - HTTP helpers:         streamPlanningChart, streamPvChart, streamModeChart
 *   - JS serializer:        configToJs (preserves function callbacks for quickchart.io eval)
 */

const QUICKCHART_HOST = 'quickchart.io';
const QUICKCHART_PATH = '/chart';

function configToJs(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'function') return val.toString();
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(v => configToJs(v)).join(',') + ']';
  const entries = Object.entries(val)
    .map(([k, v]) => `${JSON.stringify(k)}:${configToJs(v)}`)
    .join(',');
  return '{' + entries + '}';
}

function _postQuickChart(stream, body, errLabel) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: QUICKCHART_HOST,
      path: QUICKCHART_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', chunk => { errBody += chunk; });
        res.on('end', () => {
          const err = new Error(`quickchart.io ${errLabel} ${res.statusCode}: ${errBody.slice(0, 200)}`);
          stream.destroy(err);
          reject(err);
        });
        return;
      }
      res.pipe(stream);
      res.on('end', resolve);
      res.on('error', (e) => { stream.destroy(e); reject(e); });
    });
    req.on('error', (e) => { stream.destroy(e); reject(e); });
    req.write(body);
    req.end();
  });
}

async function streamPlanningChart(stream, compact) {
  const chartCfg = buildPlanningChartConfig(compact);
  if (!chartCfg) { stream.end(); return; }
  const body = JSON.stringify({
    version: '4',
    backgroundColor: '#1c1c1e',
    width: 900,
    height: 500,
    chart: configToJs(chartCfg),
  });
  return _postQuickChart(stream, body, 'planning');
}

async function streamPvChart(stream, pvData) {
  const chartCfg = buildPvChartConfig(pvData);
  if (!chartCfg) { stream.end(); return; }
  const body = JSON.stringify({
    version: '4',
    backgroundColor: '#1c1c1e',
    width: 900,
    height: 720,
    chart: configToJs(chartCfg),
  });
  return _postQuickChart(stream, body, 'PV');
}

async function streamModeChart(stream, body) {
  if (!body) { stream.end(); return; }
  return _postQuickChart(stream, body, 'mode');
}

/**
 * Build 24h-mode-history chart body (15-min slots, stacked bar + SoC line).
 * @param {Array} modeHistory - [{h: 'YYYY-MM-DDTHH:MM', m: {mode: count, ...}, soc: number}, ...]
 * @returns {string|null} JSON body for quickchart.io, or null if no data
 */
function buildModeChartBody(modeHistory) {
  if (!modeHistory?.length) return null;

  const currentSlotMs = Math.floor(Date.now() / (15 * 60000)) * (15 * 60000);
  const slots = [];
  for (let i = 95; i >= 0; i--) {
    slots.push(new Date(currentSlotMs - i * 15 * 60000).toISOString().slice(0, 16));
  }

  const bySlot = {};
  for (const b of modeHistory) bySlot[b.h] = b;

  const MODE_ORDER = [
    'to_full', 'zero_charge_only', 'pv_trickle', 'zero_discharge_only', 'zero', 'standby',
    'predictive_zero', 'predictive_charge', 'predictive_discharge', 'predictive_standby',
  ];
  const MODE_COLORS = {
    to_full:              '#5f6fff',
    zero_charge_only:     '#8b9fff',
    pv_trickle:           '#4fa8d8',
    zero_discharge_only:  '#20F29B',
    zero:                 '#FB923C',
    standby:              '#808080',
    predictive_zero:      'rgba(251,146,60,0.55)',
    predictive_charge:    'rgba(139,159,255,0.55)',
    predictive_discharge: 'rgba(32,242,155,0.55)',
    predictive_standby:   'rgba(128,128,128,0.55)',
  };
  const MODE_LABELS = {
    to_full: 'Laden', zero_charge_only: 'Laden PV', pv_trickle: 'Sprokkelen',
    zero_discharge_only: 'Ontladen',
    zero: 'Nul', standby: 'Standby',
    predictive_zero: 'HW Nul', predictive_charge: 'HW Laden',
    predictive_discharge: 'HW Ontladen', predictive_standby: 'HW Standby',
  };

  const labels = slots.map(s => {
    if (!s.endsWith(':00')) return '';
    const h = new Date(s + ':00Z').toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' });
    return h.padStart(2, '0') + 'u';
  });

  const modeDatasets = MODE_ORDER.map(mode => {
    const data = slots.map(slot => {
      const m = bySlot[slot]?.m || {};
      const total = Object.values(m).reduce((s, v) => s + v, 0);
      if (total === 0) return 0;
      return Math.round((m[mode] || 0) / total * 100);
    });
    if (!data.some(v => v > 0)) return null;
    return {
      label: MODE_LABELS[mode] || mode,
      data,
      backgroundColor: MODE_COLORS[mode] || '#888',
      stack: 'modes',
      borderWidth: 0,
    };
  }).filter(Boolean);

  const socData = slots.map(slot => bySlot[slot]?.soc ?? null);
  const hasSoC = socData.some(v => v !== null);

  const datasets = [
    ...modeDatasets,
    ...(hasSoC ? [{
      label: 'SoC %',
      data: socData,
      type: 'line',
      yAxisID: 'ySoC',
      borderColor: '#ffffff',
      backgroundColor: 'rgba(255,255,255,0.1)',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      fill: false,
      spanGaps: true,
    }] : []),
  ];

  const chartCfg = {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: false,
      plugins: {
        legend: { labels: { color: '#ccc', font: { size: 13 }, boxWidth: 12 } },
        title: {
          display: true,
          text: 'Batterij modi — afgelopen 24 uur',
          color: '#e0e0e0',
          font: { size: 15 },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: '#aaa', font: { size: 12 }, maxRotation: 0 },
          grid: { color: '#333' },
          barPercentage: 0.8,
          categoryPercentage: 1.0,
        },
        y: {
          stacked: true, min: 0, max: 100,
          ticks: { color: '#aaa', font: { size: 12 }, callback: (v) => v + '%' },
          grid: { color: '#333' },
        },
        ...(hasSoC ? {
          ySoC: {
            min: 0, max: 100, position: 'right',
            ticks: { color: '#fff', font: { size: 12 }, callback: (v) => v + '%' },
            grid: { drawOnChartArea: false },
          },
        } : {}),
      },
    },
  };

  return JSON.stringify({
    version: '4',
    backgroundColor: '#1c1c1e',
    width: 900,
    height: 500,
    chart: chartCfg,
  });
}

/**
 * Build PV forecast-vs-actual chart config (today + tomorrow, OM/SC/blended/actual lines).
 * @param {Object} pvData - { pvActual, pvForecast, pvForecastOM, pvForecastSC, pvForecastSCEffective, pvForecastDayStart, pvScDayStart, pvCapacityW }
 * @returns {Object|null} chart config for quickchart.io, or null if no data
 */
function buildPvChartConfig(pvData) {
  const { pvActual, pvForecast, pvForecastOM, pvForecastSC, pvForecastSCEffective, pvForecastDayStart, pvScDayStart, pvCapacityW } = pvData || {};
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  const pvHourly = (pvActual?.date === todayStr && Array.isArray(pvActual?.hourly)) ? pvActual.hourly : [];

  const forecastTomorrow = pvForecast?.[1] || {};

  const omTodayFull  = pvForecastOM?.[0] || {};

  const scTodaySnap = (() => {
    if (!pvScDayStart?.data || pvScDayStart.date !== todayStr) return null;
    const sums = {}, cnts = {};
    for (const slot of pvScDayStart.data) {
      const h = parseInt(new Date(slot.timestamp).toLocaleString('en-US', {
        hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam'
      }), 10);
      sums[h] = (sums[h] ?? 0) + slot.pvPowerW;
      cnts[h] = (cnts[h] ?? 0) + 1;
    }
    const result = {};
    for (const h of Object.keys(sums)) result[parseInt(h)] = Math.round(sums[h] / cnts[h]);
    return Object.keys(result).length > 0 ? result : null;
  })();

  const scTodayFull  = scTodaySnap ?? pvForecastSC?.[0] ?? {};

  const fLg = 22;
  const fMd = 19;
  const fSm = 17;

  const nowAmsHour = parseInt(
    new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10
  );

  const hasTomorrow = Object.keys(forecastTomorrow).length > 0;

  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(h);
  if (hasTomorrow) for (let h = 0; h < 24; h++) hours.push(24 + h);

  const labels = hours.map((h, i) => {
    const displayH = h % 24;
    if (displayH === 0 && i > 0) return 'Morgen';
    if (displayH % 2 === 0) return String(displayH);
    return '';
  });

  const actualData = hours.map(h => {
    if (h >= 24) return null;
    if (h > nowAmsHour) return null;
    return pvHourly[h] ?? null;
  });

  const forecastData = hours.map(h => {
    if (h >= 24) return forecastTomorrow[h - 24] ?? 0;
    if (h < nowAmsHour) {
      const om = omTodayFull[h] ?? 0;
      const sc = scTodayFull[h];
      return sc != null ? Math.round((om + sc) / 2) : om;
    }
    return (pvForecast?.[0]?.[h]) ?? 0;
  });

  const omToday    = omTodayFull;
  const omTomorrow = pvForecastOM?.[1] || {};
  const scEffToday    = pvForecastSCEffective?.[0] ?? null;
  const scEffTomorrow = pvForecastSCEffective?.[1] ?? null;
  const scToday    = scEffToday    ? { ...scTodayFull,  ...scEffToday }    : scTodayFull;
  const scTomorrow = scEffTomorrow ? { ...(pvForecastSC?.[1] || {}), ...scEffTomorrow } : (pvForecastSC?.[1] || {});
  const hasOM = Object.keys(omToday).length > 0 || Object.keys(omTomorrow).length > 0;
  const hasSC = Object.keys(scToday).length > 0 || Object.keys(scTomorrow).length > 0;

  const omData = hasOM ? hours.map(h => {
    if (h < 24) return omToday[h] ?? null;
    return omTomorrow[h - 24] ?? null;
  }) : null;
  const scData = hasSC ? hours.map(h => {
    if (h < 24) return scToday[h] ?? null;
    return scTomorrow[h - 24] ?? null;
  }) : null;

  const actualTodayKwh = pvHourly.reduce((sum, w) => sum + (w || 0), 0) / 1000;
  const forecastTodayKwh = forecastData.slice(0, 24).reduce((sum, w) => sum + (w || 0), 0) / 1000;
  const forecastTomorrowKwh = Object.values(forecastTomorrow).reduce((sum, w) => sum + (w || 0), 0) / 1000;

  const pvMax = Math.max(
    ...pvHourly.filter(v => v != null).map(v => v),
    ...forecastData.map(v => v || 0),
    ...Object.values(forecastTomorrow).map(v => v || 0),
    ...Object.values(omToday).map(v => v || 0),
    ...Object.values(omTomorrow).map(v => v || 0),
    ...Object.values(scToday).map(v => v || 0),
    ...Object.values(scTomorrow).map(v => v || 0),
    1
  );
  const yMax = pvCapacityW > 0 ? Math.max(pvCapacityW, pvMax * 1.1) : pvMax * 1.2;

  const todayDate = new Date().toLocaleDateString('nl-NL', {
    timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'long'
  });

  const updTime = new Date().toLocaleTimeString('nl-NL', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
  });

  const titleParts = [`☀ PV Opwek ${todayDate}`];
  titleParts.push(`Werkelijk: ${actualTodayKwh.toFixed(1)} kWh`);
  titleParts.push(`Verwacht: ${forecastTodayKwh.toFixed(1)} kWh`);
  if (hasTomorrow) titleParts.push(`Morgen: ${forecastTomorrowKwh.toFixed(1)} kWh`);

  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'PV Werkelijk',
          data: actualData,
          borderColor: '#FCD34D',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 4,
          pointRadius: 0,
          tension: 0.4,
          spanGaps: false,
          yAxisID: 'yPv',
        },
        {
          label: 'PV Verwachting',
          data: forecastData,
          borderColor: '#F97316',
          backgroundColor: 'rgba(249,115,22,0.08)',
          fill: true,
          borderWidth: 3,
          borderDash: [6, 3],
          pointRadius: 0,
          tension: 0.4,
          spanGaps: false,
          yAxisID: 'yPv',
        },
        ...(omData ? [{
          label: 'Open-Meteo',
          data: omData,
          borderColor: '#60A5FA',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          tension: 0.4,
          spanGaps: true,
          yAxisID: 'yPv',
        }] : []),
        ...(scData ? [{
          label: 'Solcast',
          data: scData,
          borderColor: '#34D399',
          backgroundColor: 'transparent',
          fill: false,
          borderWidth: 2.5,
          borderDash: [4, 4],
          pointRadius: 0,
          tension: 0.4,
          spanGaps: true,
          yAxisID: 'yPv',
        }] : []),
      ],
    },
    options: {
      responsive: false,
      animation: false,
      layout: {
        padding: { top: 48, bottom: 10, left: 4, right: 4 },
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#9a9a9a',
            font: { size: fLg },
            padding: 12,
            usePointStyle: true,
          },
        },
        title: {
          display: true,
          text: titleParts[0] + '  |  ' + updTime,
          color: '#FCD34D',
          font: { size: fLg, weight: 'bold' },
          padding: { bottom: 4 },
        },
        subtitle: {
          display: true,
          text: titleParts.slice(1).join('  |  '),
          color: '#cccccc',
          font: { size: fLg },
          padding: { bottom: 8 },
        },
      },
      scales: {
        x: {
          ticks: { color: '#9a9a9a', font: { size: fMd }, maxRotation: 0, autoSkip: false },
          grid: { color: '#2a2a2a' },
        },
        yPv: {
          position: 'left',
          min: 0,
          max: yMax,
          ticks: {
            color: '#FCD34D',
            font: { size: fLg, weight: 'bold' },
            callback: function(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'kW' : v + 'W'; },
          },
          grid: { color: '#2a2a2a' },
          title: { display: true, text: 'Vermogen', color: '#FCD34D', font: { size: fMd } },
        },
      },
    },
  };
}

/**
 * Build planning chart config (price bars + SoC line + PV area, today or tomorrow).
 * @param {Object} compact - { slots, currentSoc, currentMode, updatedAt, pvCapacityW }
 * @returns {Object|null} chart config for quickchart.io, or null if no slots
 */
function buildPlanningChartConfig(compact) {
  const slots = compact?.slots || [];
  const now   = Date.now();

  const shown = slots.slice(0, 96);
  if (shown.length === 0) return null;

  const fLg = 20;
  const fMd = 18;
  const fSm = 16;

  const MODE_COLORS = {
    to_full:             '#5f6fff',
    zero_charge_only:    '#8b9fff',
    pv_trickle:          '#4fa8d8',
    zero_discharge_only: '#20F29B',
    zero:                '#FB923C',
    standby:             '#808080',
    predictive:          '#02DACE',
    past:                '#aaaaaa',
  };

  const labels  = shown.map(s => {
    const min = Math.floor((s.ts % 3600000) / 60000);
    if (min !== 0) return '';
    if (s.hour === 0) {
      const d = new Date(s.ts);
      const day = d.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'numeric' });
      return day;
    }
    return String(s.hour);
  });
  const prices  = shown.map(s => s.price != null ? Math.round(s.price * 1000) / 1000 : null);
  const rawSocs = shown.map(s => s.soc != null ? s.soc : null);
  const socs = rawSocs.slice();
  for (let i = 0; i < socs.length; i++) {
    if (socs[i] != null) continue;
    if (shown[i].ts >= now) continue;
    let left = -1, right = -1;
    for (let l = i - 1; l >= 0; l--) { if (socs[l] != null) { left = l; break; } }
    for (let r = i + 1; r < socs.length; r++) { if (socs[r] != null) { right = r; break; } }
    if (left >= 0 && right >= 0) {
      socs[i] = Math.round(socs[left] + (socs[right] - socs[left]) * (i - left) / (right - left));
    } else if (left >= 0) {
      socs[i] = socs[left];
    } else if (right >= 0) {
      socs[i] = socs[right];
    }
  }
  const socActual   = socs.map((v, i) => shown[i].ts < now ? v : null);
  const socForecast = socs.map((v, i) => {
    if (shown[i].ts >= now) return v;
    if (i + 1 < shown.length && shown[i + 1].ts >= now) return v;
    return null;
  });

  const pvActual   = shown.map(s => s.ts < now ? Math.round((s.pvW || 0) / 10) * 10 : null);
  const pvForecast = shown.map((s, i) => {
    if (s.ts >= now) return Math.round((s.pvW || 0) / 10) * 10;
    if (i + 1 < shown.length && shown[i + 1].ts >= now) return Math.round((s.pvW || 0) / 10) * 10;
    return null;
  });
  const pvMax      = Math.max(...shown.map(s => Math.round((s.pvW || 0) / 10) * 10), 1);

  const barColors = shown.map(s => {
    const base = MODE_COLORS[s.mode] || '#808080';
    return base + (s.ts < now ? '77' : 'CC');
  });

  const modesPresent = [...new Set(shown.map(s => s.mode))].filter(m => m !== 'past');

  const MODE_LABELS = {
    to_full: 'Laden', zero_charge_only: 'PV laden', pv_trickle: 'Sprokkelen',
    zero_discharge_only: 'Ontladen',
    zero: 'Nul', standby: 'Standby', predictive: 'Slim laden',
  };

  const socLine  = compact?.currentSoc  != null ? `${Math.round(compact.currentSoc)}%` : '-';
  const modeLine = MODE_LABELS[compact?.currentMode] || compact?.currentMode || 'standby';

  const firstTs   = shown.find(s => s.mode !== 'past')?.ts ?? shown[0]?.ts;
  const today     = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  const slotDay   = firstTs
    ? new Date(firstTs).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' })
    : today;
  const dayLabel  = slotDay === today
    ? 'Vandaag'
    : new Date(firstTs).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long' });
  const updLine   = compact?.updatedAt
    ? new Date(compact.updatedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
    : '';

  const modeDatasets = modesPresent.map(mode => ({
    type: 'bar',
    label: MODE_LABELS[mode] || mode,
    data: [],
    backgroundColor: (MODE_COLORS[mode] || '#808080') + 'CC',
    yAxisID: 'yPrice',
    order: 99,
  }));

  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '_prijs',
          data: prices,
          backgroundColor: barColors,
          borderColor: barColors,
          borderWidth: 0,
          yAxisID: 'yPrice',
          order: 3,
        },
        {
          type: 'line',
          label: 'SoC (%)',
          data: socActual,
          borderColor: 'rgba(255,255,255,0.85)',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          pointStyle: 'line',
          yAxisID: 'ySoc',
          order: 1,
          spanGaps: true,
        },
        {
          type: 'line',
          label: '_soc_forecast',
          data: socForecast,
          borderColor: 'rgba(255,255,255,0.85)',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 0,
          pointStyle: 'line',
          yAxisID: 'ySoc',
          order: 1,
          spanGaps: true,
        },
        {
          type: 'line',
          label: 'PV',
          data: pvActual,
          borderColor: '#FCD34D',
          backgroundColor: 'rgba(252,211,77,0.15)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointStyle: 'line',
          tension: 0.4,
          spanGaps: false,
          yAxisID: 'yPv',
          order: 2,
        },
        {
          type: 'line',
          label: '_pv_forecast',
          data: pvForecast,
          borderColor: '#FCD34D',
          backgroundColor: 'rgba(252,211,77,0.08)',
          fill: true,
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          pointStyle: 'line',
          tension: 0.4,
          spanGaps: false,
          yAxisID: 'yPv',
          order: 2,
        },
        ...modeDatasets,
      ],
    },
    options: {
      responsive: false,
      animation: false,
      layout: {
        padding: { top: 12, bottom: 16, left: 4, right: 4 },
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#9a9a9a',
            font: { size: fLg },
            padding: 14,
            usePointStyle: true,
            filter: function(item) { return !item.text.startsWith('_'); },
          },
        },
        title: {
          display: true,
          text: `Batterij ${dayLabel}  |  SoC: ${socLine}  |  Nu: ${modeLine}  |  ${updLine}`,
          color: '#cccccc',
          font: { size: fLg },
          padding: { bottom: 2 },
        },
        subtitle: {
          display: true,
          text: `☀ PV max: ${pvMax >= 1000 ? `${(pvMax/1000).toFixed(1)}kW` : `${pvMax}W`}`,
          color: '#FCD34D',
          font: { size: fSm, weight: 'bold' },
          padding: { bottom: 6 },
        },
      },
      scales: {
        x: {
          ticks: { color: '#9a9a9a', font: { size: fMd }, maxRotation: 0, autoSkip: false },
          grid: { color: '#2a2a2a' },
        },
        yPrice: {
          position: 'left',
          ticks: {
            color: '#cccccc',
            font: { size: fLg, weight: 'bold' },
            callback: (v) => v.toFixed(2),
          },
          grid: { color: '#2a2a2a' },
          title: { display: true, text: 'EUR/kWh', color: '#9a9a9a', font: { size: fSm } },
        },
        ySoc: {
          position: 'right',
          min: 0,
          max: 100,
          ticks: {
            color: 'rgba(255,255,255,0.85)',
            font: { size: fLg, weight: 'bold' },
            callback: (v) => `${v}%`,
          },
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'SoC', color: 'rgba(255,255,255,0.6)', font: { size: fSm } },
        },
        yPv: {
          display: false,
          position: 'right',
          min: 0,
          max: compact?.pvCapacityW > 0 ? compact.pvCapacityW : pvMax * 1.2,
          ticks: { display: false },
          grid: { drawOnChartArea: false },
        },
      },
    },
  };
}

module.exports = {
  configToJs,
  buildPlanningChartConfig,
  buildPvChartConfig,
  buildModeChartBody,
  streamPlanningChart,
  streamPvChart,
  streamModeChart,
};
