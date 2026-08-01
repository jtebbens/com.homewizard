// V8 heap SAMPLING profiler over CDP: attributes allocated bytes to call stacks.
// This is an allocation-attribution run, NOT an RSS measurement — the inspector
// perturbs RSS, so never read RSS numbers out of this run.
const WebSocket = require('/root/.nvm/versions/node/v22.21.1/lib/node_modules/homey/node_modules/ws');
const http = require('http');

const DURATION_MS = Number(process.argv[2] || 240000);

const get = () => new Promise((res, rej) => {
  http.get('http://127.0.0.1:9229/json', r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
  }).on('error', rej);
});

(async () => {
  const [target] = await get();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });

  await new Promise(r => ws.on('open', r));
  await send('HeapProfiler.enable');
  // Without these two flags V8 reports only samples that SURVIVED to stopSampling,
  // which hides all short-lived churn — exactly what drives GC pressure.
  await send('HeapProfiler.startSampling', {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  console.error(`sampling ${DURATION_MS / 1000}s...`);
  await new Promise(r => setTimeout(r, DURATION_MS));
  const { profile } = await send('HeapProfiler.stopSampling');
  ws.close();

  // Flatten the tree: attribute selfSize to each node, and also roll up to
  // the nearest frame that lives in the app (not node internals).
  const byFrame = new Map();
  let total = 0;
  const walk = (node, stack) => {
    const cf = node.callFrame;
    const key = `${cf.functionName || '(anon)'} @ ${(cf.url || '').replace(/^.*\/(?:app|lib|drivers)\//, '')}:${cf.lineNumber + 1}`;
    const s = [...stack, key];
    if (node.selfSize > 0) {
      total += node.selfSize;
      const cur = byFrame.get(key) || { self: 0, stack: s };
      cur.self += node.selfSize;
      byFrame.set(key, cur);
    }
    for (const c of node.children || []) walk(c, s);
  };
  walk(profile.head, []);

  const rows = [...byFrame.entries()].sort((a, b) => b[1].self - a[1].self);
  console.log(`total sampled allocation: ${(total / 1048576).toFixed(1)} MB over ${DURATION_MS / 1000}s\n`);
  for (const [k, v] of rows.slice(0, 25)) {
    console.log(`${(v.self / 1048576).toFixed(2).padStart(7)} MB  ${(100 * v.self / total).toFixed(1).padStart(5)}%  ${k}`);
    console.log(`          via ${v.stack.slice(-5, -1).reverse().join(' ← ') || '(root)'}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
