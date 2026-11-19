// Performance targets, on the worker bundle in Node (the wasm runs as in the browser):
// a 1M-packet file loads without blocking the main thread; a filter over 100k packets in < 1 s; the details of a
// packet in < 10 ms; memory close to the file size. Uses the quickstart data of the Yamcs packet viewer (test/data).
// node test/perf.mjs [packets]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { PacketViewerClient } from '../dist/packet-viewer-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, 'data');
const wanted = Number(process.argv[2] || 1_000_000);

function nodeWorker(source) {
  const bootstrap = `
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.postMessage = (m) => parentPort.postMessage(m);
    parentPort.on('message', (m) => globalThis.onmessage({ data: m }));
    (0, eval)(workerData);`;
  const t = new Worker(bootstrap, { eval: true, workerData: source });
  const w = { postMessage: (m, tr) => t.postMessage(m, tr), terminate: () => t.terminate() };
  t.on('message', (m) => w.onmessage({ data: m }));
  t.on('error', (e) => w.onerror(e));
  return w;
}

const config = {
  fileFormats: [
    {
      name: 'CCSDS Packets',
      packetInputStreamClassName: 'org.yamcs.tctm.GenericPacketInputStream',
      packetInputStreamArgs: {
        lengthFieldOffset: 4, maxPacketLength: 1500, lengthFieldLength: 2, lengthAdjustment: 7, initialBytesToStrip: 0,
      },
    },
  ],
};

const MB = (n) => `${(n / 1048576).toFixed(0)} MB`;
const sec = (ms) => `${(ms / 1000).toFixed(2)} s`;

/** the longest the main thread waited for a timer while `promise` ran: what a user would feel as a freeze */
async function maxLag(promise) {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 10);
    last = now;
  }, 10);
  try {
    return { result: await promise, lag: max };
  } finally {
    clearInterval(t);
  }
}

const one = readFileSync(join(data, 'testdata.ccsds'));
const c = new PacketViewerClient({ createWorker: nodeWorker });
try {
  await c.init(config);
  await c.loadMdb([readFileSync(join(data, 'xtce.xml'), 'utf8')]);
  const base = (await c.request({ op: 'status' })).memoryBytes;

  // 1800 packets per copy
  const file = new Blob(Array(Math.ceil(wanted / 1800)).fill(one));
  let t = performance.now();
  let progress = 0;
  const { result: f, lag } = await maxLag(c.openFile(file, 0, () => progress++));
  const load = performance.now() - t;
  console.log(
    `load ${f.packetCount} packets (${MB(file.size)}): ${sec(load)}, ${Math.round(f.packetCount / (load / 1000))} packets/s;` +
      ` ${progress} progress messages, main thread max lag ${lag.toFixed(0)} ms`,
  );
  const mem = f.memoryBytes - base;
  console.log(`memory: wasm ${MB(f.memoryBytes)}, ${MB(mem)} for the packets (file ${MB(file.size)}), ` +
    `${((mem - file.size) / f.packetCount).toFixed(0)} bytes/packet beyond the data`);
  assert.ok(lag < 200, 'the main thread was blocked');

  t = performance.now();
  let { rows } = await c.rows(f.packetCount - 50, f.packetCount);
  console.log(`50 rows at the end: ${(performance.now() - t).toFixed(1)} ms`);
  assert.equal(rows.length, 50);

  t = performance.now();
  const N = 200;
  for (let i = 0; i < N; i++) await c.select(1 + Math.floor((i * f.packetCount) / N));
  const sel = (performance.now() - t) / N;
  console.log(`select (details, tree, hex): ${sel.toFixed(2)} ms`);
  assert.ok(sel < 10);

  // the filter over 100k packets
  await c.request({ op: 'clear' });
  const f100 = await c.openFile(new Blob(Array(Math.ceil(100_000 / 1800)).fill(one)), 0);
  t = performance.now();
  const fr = await c.setFilter('ElapsedSeconds > 5 AND Shadow == true');
  const filter = performance.now() - t;
  console.log(`filter over ${f100.packetCount} packets: ${filter.toFixed(0)} ms, ${fr.rowCount} match`);
  assert.ok(filter < 1000);
} finally {
  c.terminate();
}
