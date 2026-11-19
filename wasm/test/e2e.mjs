// End-to-end test of dist/packet-viewer-client.js in Node: the worker runs in a worker thread with the
// globals of a web worker. Uses the quickstart data of the Yamcs packet viewer (test/data).
// node test/e2e.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { PacketViewerClient } from '../dist/packet-viewer-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, 'data');

/** a web Worker look-alike running the source in a worker thread */
function nodeWorker(source) {
  const bootstrap = `
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.postMessage = (m) => parentPort.postMessage(m);
    parentPort.on('message', (m) => globalThis.onmessage({ data: m }));
    (0, eval)(workerData);`;
  const t = new Worker(bootstrap, { eval: true, workerData: source });
  const w = {
    postMessage: (m, transfer) => t.postMessage(m, transfer),
    terminate: () => t.terminate(),
  };
  t.on('message', (m) => w.onmessage({ data: m }));
  t.on('error', (e) => w.onerror(e));
  return w;
}

const config = {
  packetPreprocessorClassName: 'org.yamcs.tctm.GenericPacketPreprocessor',
  packetPreprocessorArgs: { timestampOffset: -1, seqCountOffset: -1 },
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

const log = [];
const c = new PacketViewerClient({ createWorker: nodeWorker, onLog: (m) => log.push(m) });
try {
  assert.deepEqual((await c.init(config)).fileFormats, ['CCSDS Packets']);
  const mdb = await c.loadMdb([readFileSync(join(data, 'xtce.xml'), 'utf8')]);
  assert.equal(mdb.rootContainer, '/myproject/CCSDSPacket');
  assert.deepEqual(log, ['Loaded definition of 3 sequence containers and 40 parameters']);

  // file
  // (file-backed blobs cannot be sent to worker threads in Node)
  const file = new Blob([readFileSync(join(data, 'testdata.ccsds'))]);
  const progress = [];
  const f = await c.openFile(file, 0, (p) => progress.push(p));
  assert.equal(f.packetCount, 1800);
  assert.equal(f.truncated, false);
  assert.deepEqual(f.range, [1, 1800]);

  // rows, columns
  assert.equal((await c.request({ op: 'addColumn', qualifiedName: '/myproject/ElapsedSeconds' })).added, true);
  const { rows, rowCount } = await c.rows(0, 3);
  assert.equal(rowCount, 1800);
  assert.deepEqual(rows.map((r) => [r.nr, r.name, r.length, r.columns]), [
    [1, '/myproject/Spacecraft', 123, ['0']],
    [2, '/myproject/Spacecraft', 123, ['1']],
    [3, '/myproject/Spacecraft', 123, ['2']],
  ]);

  // filter
  const invalid = await c.validateFilter('Height > 800.5');
  assert.equal(invalid.ok, false);
  assert.equal(typeof invalid.message, 'string');
  assert.equal(typeof invalid.position, 'number');
  assert.equal((await c.validateFilter('ElapsedSeconds == 7')).ok, true);
  const fr = await c.setFilter('ElapsedSeconds < 10');
  assert.deepEqual(fr, { ok: true, rowCount: 10 });
  assert.equal((await c.setFilter('x ==')).ok, false);
  assert.equal((await c.request({ op: 'status' })).rowCount, 1800);
  await c.setFilter(null);

  // details
  const d = await c.select(3);
  assert.equal(d.name, '/myproject/Spacecraft');
  assert.equal(d.row, 2);
  const e1 = d.params.find((p) => p.name === 'Enum_Para_1');
  assert.deepEqual(e1.calibration, { kind: 'enumeration', typeName: 'EnumerationTest' });
  assert.equal(d.tree.children[3].label, 'TelemetryPacket');
  const h = await c.request({ op: 'highlight', ranges: [[e1.bitOffset, e1.bitSize]] });
  // bits 29..31 are in the 8th nibble of 0064 c002
  assert.equal(d.hex.slice(...h.spans[0]), '2');
  const lov = await c.request({ op: 'enumValues', qualifiedName: '/myproject/Enum_Para_1' });
  assert.equal(lov.typeName, 'EnumerationTest');
  assert.equal((await c.request({ op: 'copyHex', nr: 1 })).hex.slice(0, 8), '0064C000');
  await assert.rejects(c.select(5000), /There is no packet number 5000/);

  // packets from Yamcs
  const p1 = new Uint8Array(await file.slice(0, 123).arrayBuffer());
  const a = await c.addPackets([{ data: p1, generationTime: '2026-11-19T10:00:00.123456Z' }, { data: p1 }]);
  assert.equal(a.added, 2);
  assert.equal(a.packetCount, 1802);
  const last = (await c.rows(1800, 1802)).rows;
  assert.equal(last[0].generationTime, '2026-11-19/323T10:00:00.123');
  assert.equal(last[0].name, '/myproject/Spacecraft');

  // a big file: speed, filter progress and cancel
  const big = new Blob(Array(100).fill(file));
  let t = performance.now();
  let fileProgress = 0;
  const b = await c.openFile(big, 0, () => fileProgress++);
  const loadMs = performance.now() - t;
  assert.equal(b.packetCount, 180000);
  assert.ok(fileProgress > 0);
  t = performance.now();
  const filterProgress = [];
  const all = await c.setFilter('ElapsedSeconds > 5 AND Shadow == true', (p) => filterProgress.push(p));
  const filterMs = performance.now() - t;
  assert.equal(all.rowCount, 133400);
  assert.ok(filterProgress.length > 0);
  const pf = c.setFilter('ElapsedSeconds == 7', () => c.cancel(pf));
  const cancelled = await pf;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.rowCount, 180000);
  // a new filter supersedes the one in progress
  const first = c.setFilter('ElapsedSeconds == 7');
  const second = c.setFilter('ElapsedSeconds == 8');
  assert.equal((await first).cancelled, true);
  assert.equal((await second).rowCount, 100);
  const pfile = c.openFile(big, 0, () => c.cancel(pfile));
  assert.equal((await pfile).cancelled, true);
  assert.equal((await c.request({ op: 'status' })).packetCount, 0);

  console.log(`ok; 180k packets: load ${loadMs.toFixed(0)} ms, filter ${filterMs.toFixed(0)} ms`);
} finally {
  c.terminate();
}
