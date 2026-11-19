# Packet viewer worker protocol

The UI talks to a Web Worker running `pv-wasm`. `wasm/build.mjs` produces
`wasm/dist/packet-viewer-client.js` (+ `.d.ts`): one ES module containing the client, the worker source
and the gzipped wasm, as yamcs-web extensions must be a single bundle. The worker is started from a blob
URL; the wasm is instantiated from bytes (no `application/wasm` MIME type needed). The module needs no
imports: `pv_alloc`, `pv_free`, `pv_call` and `memory` are its only exports.

```js
import { PacketViewerClient } from './packet-viewer-client.js';
const pv = new PacketViewerClient({ onLog: (message) => appendToLogPanel(message) });
await pv.init(config);                  // config from GET /api/packet-viewer/{instance}/config
await pv.loadMdb([xtce], rootContainer);
const f = pv.openFile(file, 0, (p) => showProgress(p.bytes / p.total));
pv.cancel(f);                           // f resolves with {cancelled: true}
const { rows } = await pv.rows(0, 50);
```

## Messages

UI → worker: `{id, op, ...arguments}`; `{cancel: id}` cancels an `openFile` or `setFilter`.

Worker → UI:
- `{id, reply}` or `{id, error: message}` — the end of a request;
- `{id, progress}` — during `openFile` and `setFilter`, at most every 200 ms;
- `{log: message}` — a message for the log panel (Java `PacketViewer.log`).

Requests are handled in order. `openFile` and `setFilter` give way to the other requests between steps
(a file chunk, 20000 filtered packets), so rows can be shown while they run. A new `openFile` or
`setFilter` supersedes the one in progress, which resolves with `{cancelled: true}`.

## Requests

| op | arguments | reply |
|---|---|---|
| `init` | `config` (packet-viewer.yaml as JSON) | `{fileFormats: string[]}` — must be first; resets everything |
| `loadMdb` | `xtce: string[]`, `rootContainer?` (Yamcs `Mdb.getRootSequenceContainer()`) | `{message, rootContainer}`; clears packets and columns |
| `setSource` | `format`: file format index, or null for packets from Yamcs | `{rootContainer}` |
| `setMaxLines` | `maxLines` (null: no limit) | status |
| `clear` | | status |
| `openFile` | `file: Blob`, `format` | status + `{filePackets, truncated}`; progress `{bytes, total, packets}` |
| `addPackets` | `lengths[]`, `generationTimes[]` (ISO UTC; null: the realtime preprocessor decides), `now` (unix ms), `data` (the packets concatenated, transferable) | status + `{added}` |
| `status` | | `{packetCount, rowCount, filtering, range: [first, last] \| null, maxHistory, memoryBytes}` (the wasm memory, which only grows) |
| `rows` | `from`, `to` (row indices, after the filter) | `{rows: Row[], rowCount}` |
| `rowOf` | `nr` | `{row}` (null if filtered out); error if there is no such packet |
| `addColumn` | `qualifiedName` | `{added, columns}` |
| `removeColumn` | `index` | `{columns}` |
| `validateFilter` | `expr` | `{ok, message?, position?}` |
| `setFilter` | `expr` (null or blank: none) | `{ok, rowCount, message?, position?, cancelled?}`; progress `{scanned, total, rowCount}`. Invalid or cancelled: no filter |
| `select` | `nr` | `PacketDetails` (+ `row`, `canGoBack`, `canGoForward`); error `There is no packet number N` |
| `back`, `forward` | | `{nr}` to select, or null |
| `neighbour` | `row` (selected row or null), `up` | `{row}` |
| `toggleMark` | `nr` | `{marked}` |
| `highlight` | `ranges: [bitOffset, bitSize][]` | `{spans: [start, end][], scroll}` — character ranges of `PacketDetails.hex` |
| `copyHex` | `nr` | `{hex}` (upper case, like Java "Copy hex") |
| `enumValues` | `qualifiedName` | `{typeName, values: [value, label][]}` or null |
| `parameters` | | `{parameters: string[]}` — qualified names, for the column chooser |

The types (`Row`, `PacketDetails`, `ParamRow`, `TreeNode`, …) are in `wasm/js/client.d.ts`. Times are
shown in the Java format `yyyy-MM-dd/DDDTHH:mm:ss.SSS`.

## pv-wasm ABI

`pv_call(req_ptr, req_len, data_ptr, data_len) -> ptr`: the request is UTF-8 JSON `{op, ...}` (the ops
above except `openFile`/`setFilter`, which the worker implements with `beginFile`/`fileChunk`/`endFile`
and `startFilter`/`filterStep`); `data` is the binary payload (file chunk, packets). Both buffers come
from `pv_alloc(len)` and are freed by the call. The reply at `ptr` is a little-endian u32 length and the
JSON, valid until the next call; failures are `{"error": message}`, log messages are in `"log"`.
