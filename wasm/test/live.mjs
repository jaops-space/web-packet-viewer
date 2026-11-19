// The whole chain against the dev Yamcs (dev/yamcs, mvn yamcs:run): the plugin's config and MDB, packets from the
// Yamcs archive API, decoded by the worker bundle. node test/live.mjs [http://localhost:8091] [simulator]
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { PacketViewerClient } from '../dist/packet-viewer-client.js';

const base = process.argv[2] || 'http://localhost:8091';
const instance = process.argv[3] || 'simulator';

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

async function get(path, headers = {}) {
  const r = await fetch(base + path, { headers });
  if (!r.ok && r.status !== 304) {
    throw new Error(`${path}: ${r.status} ${await r.text()}`);
  }
  return r;
}

const config = await (await get(`/packet-viewer/api/${instance}/config`)).json();
const mdbResponse = await get(`/packet-viewer/api/${instance}/mdb`);
assert.equal(mdbResponse.headers.get('etag'), config.mdbEtag);
assert.equal((await get(`/packet-viewer/api/${instance}/mdb`, { 'If-None-Match': config.mdbEtag })).status, 304);
const mdb = await mdbResponse.json();
console.log(`MDB: ${mdb.source}, ${mdb.documents.map((d) => d.name).join(' ')}; root ${config.rootContainer}`);

const log = [];
const c = new PacketViewerClient({ createWorker: nodeWorker, onLog: (m) => log.push(m) });
try {
  const init = await c.init(config.viewer);
  const loaded = await c.loadMdb(mdb.documents.map((d) => d.xtce), config.rootContainer);
  assert.equal(loaded.rootContainer, config.rootContainer);
  console.log(loaded.message, '| file formats:', init.fileFormats.join(', '));

  // packets from Yamcs, as the live/archive mode will receive them
  const { packet = [] } = await (await get(`/api/archive/${instance}/packets?limit=200&order=asc`)).json();
  assert.ok(packet.length > 0, 'no packets in the archive');
  await c.request({ op: 'setSource', format: null });
  const added = await c.addPackets(packet.map((p) => ({
    data: Uint8Array.from(Buffer.from(p.packet, 'base64')),
    generationTime: p.generationTime,
  })));
  assert.equal(added.added, packet.length);
  const { rows } = await c.rows(0, added.rowCount);
  const yamcsNames = packet.map((p) => p.id?.name);
  const unknown = rows.filter((r) => r.name === 'unknown').length;
  const same = rows.filter((r, i) => r.name === yamcsNames[i]).length;
  console.log(`${rows.length} packets from the archive: ${same} named as Yamcs names them, ${unknown} unknown`);
  assert.equal(unknown, 0);

  // decode each packet: no decoding errors
  let errors = 0;
  for (const r of rows) {
    const d = await c.select(r.nr);
    if (d.decodeError) {
      errors++;
      if (errors < 4) console.log(`#${r.nr} ${r.name}: ${d.decodeError}`);
    }
  }
  console.log(`details of ${rows.length} packets: ${errors} decoding errors`);
  const flight = rows.find((r) => r.name === '/SIMULATOR/FlightData');
  if (flight) {
    const d = await c.select(flight.nr);
    console.log(`#${flight.nr} ${flight.generationTime}`, d.params.slice(0, 12).map((p) => `${p.name}=${p.engValue}`).join(' '));
  }
  assert.equal(errors, 0);
  console.log('ok; log:', log);
} finally {
  c.terminate();
}
