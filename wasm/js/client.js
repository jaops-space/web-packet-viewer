// The main-thread side: starts the worker from an embedded source (yamcs-web extensions are a single
// bundle) and turns its messages into promises. See docs/protocol.md.

const WORKER_SOURCE = __WORKER_SOURCE__;

export class PacketViewerClient {
  /**
   * @param {object} [options]
   * @param {(message: string) => void} [options.onLog] messages for the log panel
   * @param {() => Worker} [options.createWorker] for tests; by default a Worker from a blob URL
   */
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    if (options.createWorker) {
      this.worker = options.createWorker(WORKER_SOURCE);
    } else {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
    }
    this.worker.onmessage = (e) => this.receive(e.data);
    this.worker.onerror = (e) => {
      const err = new Error('packet viewer worker: ' + (e.message || e));
      for (const p of this.pending.values()) {
        p.reject(err);
      }
      this.pending.clear();
    };
  }

  receive(m) {
    if (m.log !== undefined) {
      this.onLog(m.log);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) {
      return;
    }
    if (m.progress !== undefined) {
      p.onProgress && p.onProgress(m.progress);
    } else {
      this.pending.delete(m.id);
      m.error !== undefined ? p.reject(new Error(m.error)) : p.resolve(m.reply);
    }
  }

  /**
   * Sends a request; the promise has an `id` property for cancel().
   * @param {object} req `{op, ...}`
   * @param {object} [options] `{onProgress, transfer}`
   */
  request(req, options = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: options.onProgress });
    });
    promise.id = id;
    this.worker.postMessage({ ...req, id }, options.transfer || []);
    return promise;
  }

  /** cancels an openFile or setFilter request; it resolves with `cancelled: true` */
  cancel(promise) {
    this.worker.postMessage({ cancel: promise.id });
  }

  terminate() {
    this.worker.terminate();
  }

  // ---- convenience wrappers

  init(config) {
    return this.request({ op: 'init', config });
  }

  loadMdb(xtce, rootContainer) {
    return this.request({ op: 'loadMdb', xtce, rootContainer });
  }

  openFile(file, format, onProgress) {
    return this.request({ op: 'openFile', file, format }, { onProgress });
  }

  /** @param {{data: Uint8Array, generationTime?: string}[]} packets */
  addPackets(packets) {
    const lengths = packets.map((p) => p.data.byteLength);
    const data = new Uint8Array(lengths.reduce((a, b) => a + b, 0));
    let offset = 0;
    for (const p of packets) {
      data.set(p.data, offset);
      offset += p.data.byteLength;
    }
    const generationTimes = packets.map((p) => p.generationTime ?? null);
    return this.request(
      { op: 'addPackets', lengths, generationTimes, now: Date.now(), data },
      { transfer: [data.buffer] },
    );
  }

  rows(from, to) {
    return this.request({ op: 'rows', from, to });
  }

  setFilter(expr, onProgress) {
    return this.request({ op: 'setFilter', expr }, { onProgress });
  }

  validateFilter(expr) {
    return this.request({ op: 'validateFilter', expr });
  }

  select(nr) {
    return this.request({ op: 'select', nr });
  }
}
