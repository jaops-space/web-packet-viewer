// The packet viewer worker: runs pv-wasm and answers the requests of PacketViewerClient (docs/protocol.md).
// The build embeds it in the client bundle, preceded by `const WASM_GZ_BASE64 = "...";`.
/* global WASM_GZ_BASE64 */

const FILTER_STEP = 20000; // packets filtered between two checks for cancel
const PROGRESS_MS = 200; // minimum interval between progress messages

let wasm;
const ready = instantiate().catch((e) => {
  wasm = e;
});
const cancelled = new Set();
// the openFile and setFilter in progress: a new one supersedes the previous one
const current = { file: undefined, filter: undefined };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function instantiate() {
  const gz = Uint8Array.from(atob(WASM_GZ_BASE64), (c) => c.charCodeAt(0));
  const bytes = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  wasm = instance.exports;
}

function copyIn(bytes) {
  const ptr = wasm.pv_alloc(bytes.length);
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

/** a synchronous call to pv-wasm; throws the error of the reply */
function call(req, data) {
  const r = encoder.encode(JSON.stringify(req));
  const d = data ? new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength) : new Uint8Array(0);
  const rp = copyIn(r);
  const dp = copyIn(d);
  const out = wasm.pv_call(rp, r.length, dp, d.length);
  const len = new DataView(wasm.memory.buffer).getUint32(out, true);
  const reply = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, out + 4, len)));
  if (reply.log) {
    for (const message of reply.log) {
      postMessage({ log: message });
    }
    delete reply.log;
  }
  if (reply.error !== undefined) {
    throw new Error(reply.error);
  }
  return reply;
}

const yieldToEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

function progressSender(id) {
  let last = 0;
  return (progress, force) => {
    const now = Date.now();
    if (force || now - last >= PROGRESS_MS) {
      last = now;
      postMessage({ id, progress });
    }
  };
}

async function openFile(id, { file, format }) {
  current.file = id;
  call({ op: 'beginFile', format });
  const progress = progressSender(id);
  const reader = file.stream().getReader();
  let bytes = 0;
  let status;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (current.file !== id) {
        return { cancelled: true };
      }
      if (done) {
        break;
      }
      if (cancelled.has(id)) {
        call({ op: 'endFile' });
        return { cancelled: true, ...call({ op: 'clear' }) };
      }
      bytes += value.byteLength;
      status = call({ op: 'fileChunk', now: Date.now() }, value);
      progress({ bytes, total: file.size, packets: status.filePackets });
    }
  } finally {
    reader.releaseLock();
    if (current.file === id) {
      current.file = undefined;
    }
  }
  return call({ op: 'endFile' });
}

async function setFilter(id, { expr }) {
  current.filter = id;
  try {
    return await scanFilter(id, expr);
  } finally {
    if (current.filter === id) {
      current.filter = undefined;
    }
  }
}

async function scanFilter(id, expr) {
  const start = call({ op: 'startFilter', expr });
  if (!start.ok || !start.scan) {
    return start;
  }
  const progress = progressSender(id);
  for (;;) {
    const p = call({ op: 'filterStep', max: FILTER_STEP });
    if (p.done) {
      return { ok: true, rowCount: p.rowCount };
    }
    progress({ scanned: p.scanned, total: p.total, rowCount: p.rowCount });
    await yieldToEvents();
    if (current.filter !== id) {
      return { cancelled: true };
    }
    if (cancelled.has(id)) {
      // like an empty filter field
      return { cancelled: true, ...call({ op: 'startFilter', expr: null }) };
    }
  }
}

async function handle(id, req) {
  await ready;
  if (!wasm || wasm instanceof Error) {
    throw new Error('cannot load the packet viewer module: ' + wasm);
  }
  switch (req.op) {
    case 'openFile':
      return openFile(id, req);
    case 'setFilter':
      return setFilter(id, req);
    default: {
      const { data, ...rest } = req;
      return call(rest, data);
    }
  }
}

onmessage = async (e) => {
  const { id, cancel, ...req } = e.data;
  if (cancel !== undefined) {
    cancelled.add(cancel);
    return;
  }
  try {
    const reply = await handle(id, req);
    postMessage({ id, reply });
  } catch (err) {
    postMessage({ id, error: err && err.message ? err.message : String(err) });
  } finally {
    cancelled.delete(id);
  }
};
