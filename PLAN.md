# Web Packet Viewer for Yamcs-web — implementation plan

Goal: the Yamcs Packet Viewer (`~/git/yamcs/packet-viewer`, Swing) re-implemented as a Yamcs-web
extension, menu **Telemetry → Packet Viewer**. Packets travel as raw binaries; all decoding happens
in the browser with `xtce-rs` compiled to WebAssembly. The server only provides the MDB (once,
cached) and the raw packets.

Packaging follows `~/git/fops`: a Yamcs plugin jar that carries the built web UI, extracts it at
startup and registers it with `WebPlugin.addExtension(...)`; an Angular custom-element bundle built
against `@yamcs/webapp-sdk`.

---

## 1. Functional inventory of the Java viewer (the parity target)

| Area | Java behaviour | Web equivalent |
|---|---|---|
| **Packet sources** | *File → Open…*: local file + file format + MDB name from `mdb.yaml`. *File → Connect to Yamcs…*: URL, auth, instance, stream, server MDB or local MDB | **Live** (WebSocket `packets` topic, instance + stream, processor), **Archive** (time range + packet names, from the server), **Local file** (browser File API, file formats from the plugin config). MDB = the instance's MDB from the server; optionally a local XTCE file instead (the "local MDB" choice). Auth/URL disappear (Yamcs-web session) |
| File formats | `fileFormats` in `packet-viewer.yaml`: `CcsdsPacketInputStream`, `GenericPacketInputStream` (lengthFieldOffset/Length, lengthAdjustment, initialBytesToStrip, maxPacketLength), per-format preprocessor, `rootContainer` | Same YAML block, now in the plugin config in `yamcs.yaml`, served to the UI; splitters and preprocessors re-implemented in Rust |
| Preprocessor | `IssPacketPreprocessor` (default) or configured class; gives generation time; `checkForSequenceDiscontinuity(false)` | Rust: `Iss`, `Ccsds` (CUC time) and `Generic` (timestamp offset/encoding) preprocessors; only for local files — server packets already carry `generationTime` |
| Recent files (4, File menu) | Java prefs | Only names + format + MDB in `localStorage`; reopening needs the file again (or File System Access handles in IndexedDB on Chromium, best effort) |
| Packets table (left) | Columns `#`, Generation Time, Packet Name, Length + user parameter columns; no sorting; packet name = deepest container matched at offset 0 (alias in `defaultNamespace` if configured, else qualified name); `maxLines` (‑l; default 1000 live, unlimited file) drops oldest rows | Same, virtual-scrolled table (cdk virtual scroll) whose rows are fetched from the worker by range |
| Parameter columns | Right-click param → *Apply as Left Column*; header right-click → *Hide Column*; persisted (JSON list of qualified names) | Same, persisted per instance in `localStorage` |
| Mark packet | Ctrl+M / context menu, yellow background | Same |
| Navigation | Go to Packet… (Ctrl+G, range-checked dialog), Back/Forward (Alt+←/→, history of 10), Previous/Next packet (Alt+↑/↓) | Same; Alt+←/→ are browser history keys → `preventDefault` while the viewer has focus, plus toolbar buttons |
| View menu | Auto-Scroll To Last Packet (on), Auto-Select Last Packet (off), Clear | Same |
| Display filter | Editable combo; JavaCC grammar (`AND/&&`, `OR/\|\|`, `NOT/!` + parens, `== != < <= > >= EQ NE LT LE GT GE CONTAINS MATCHES ~`, quoted strings, refs `packet.name`, `packet.length`, `/qualified/name`, short name); red background while invalid; history of 10 | Grammar ported 1:1 to Rust (hand-written lexer with the two lexer states `DEFAULT`/`IN_EXPRESSION`); same semantics including the quirks (string compare of eng value, `Double` compare, regex full-match case-insensitive, short names resolved inside the packet, missing parameter ⇒ no match) |
| Parameters tab | Columns Name, Eng Value, Raw Value, Nominal Low/High, Danger Low/High, Bit Offset, Bit Size, Calibration; zebra rows; enumeration type shown as link → *List of Values* dialog with the raw value preselected | Same |
| Context menu on parameter | Apply as Left Column; Apply as Filter → Selected (`name == value`) / Not Selected (`!(name == value)`) | Same |
| Find bar | Ctrl+F; substring on name; next/prev with wrap; "n of m"; "Parameter not found" in red; Esc closes; bold matches | Same; Ctrl+F intercepted only when focus is inside the viewer |
| Structure tab | Tree: containers (OPS name alias or name) nested by inheritance and by container start offset; leaves `bitOffset/bitSize name`; multi-select highlights | Same |
| Hex dump | `oooo hhhh hhhh … ascii`, 16 bytes/line, highlight of selected bit ranges (nibble precision) in hex and ASCII, scroll to first highlight; *Copy hex* | Same, rendered as a monospaced `<pre>` built of line spans (virtualised for big packets) |
| Log panel | Messages: MDB loaded (n containers/parameters), loaded n packets, errors, connection state | Same, bottom split |
| Progress | `ProgressMonitor` with cancel while loading a file | Progress bar + Cancel; decoding runs in a Web Worker |
| Title | `Yamcs Packet Viewer - file` / `[url]` | Page toolbar label shows the source |
| CLI options | `-l n -x MDB -i INSTANCE -s STREAM file|url` | URL query parameters on the route: `?c=<instance>&source=live&stream=tm_realtime&limit=1000`, or `source=archive&start=…&stop=…&name=…` |

Not ported (no meaning in the browser): server URL / auth types / Kerberos, `--etc-dir`, Quit.

---

## 2. Architecture

```
Browser (Yamcs-web)
 ├─ <web-packet-viewer>   startup element: adds "Packet Viewer" to the Telemetry nav group
 ├─ <packet-viewer>         routed at /ext/packet-viewer?c=<instance>   (Angular, UI only)
 │     │  postMessage (structured clone / transferables)
 │     ▼
 └─ Web Worker  ── pv-wasm (Rust → wasm32) ── pv-core ── xtce-rs
        packet store (arena), splitter, preprocessors, decoder, filter, hexdump/highlight

Yamcs server
 └─ plugin "web-packet-viewer" (Java)
       ├─ registers the web extension
       ├─ GET  /api/packet-viewer/{instance}/config   file formats, rootContainer, defaultNamespace, limits
       └─ GET  /api/packet-viewer/{instance}/mdb      XTCE of the instance MDB (ETag = MDB fingerprint)
    + standard Yamcs APIs: WebSocket topic "packets", /api/archive/{instance}/packets, :exportPackets,
      /api/archive/{instance}/packet-names, /api/streams
```

Why a worker: decoding a 100k-packet file or re-filtering must not freeze Yamcs-web (the Java
version uses `SwingWorker`). All state that grows with the number of packets (raw bytes, names,
times, column values, marks) lives in the worker/wasm memory; the UI asks for row windows.

### Repository layout (`web-packet-viewer`)

```
core/      Rust crate pv-core   (depends on xtce-rs from crates.io); native, unit + golden tests
wasm/      Rust crate pv-wasm   (wasm-bindgen API over pv-core, worker message loop)
web/       Angular extension    (copy of the fops web/ setup: Angular 22, webapp-sdk 1.6.7)
plugin/    Maven, Java plugin   (com.jaops.yamcs:web-packet-viewer, mirrors fops plugin/)
docs/      contract between the parts (like fops docs/plugin-api.md)
```

### Single-bundle constraint

Yamcs-web serves an extension's files from its own root and includes **every** `.js`/`.css` it
finds (fops `scripts/postbuild.mjs` forbids extra chunks). So a separate `worker.js` or a
`.wasm` with an `application/wasm` MIME type cannot be relied upon. Solution:

1. `wasm-pack build --target no-modules` (or `wasm-bindgen --target no-modules`), `wasm-opt -Oz`.
2. A small build script bundles the worker JS + glue (esbuild) and the `.wasm` (base64, or
   gzipped + `DecompressionStream`) into a generated TS module exporting two strings.
3. At runtime: `new Worker(URL.createObjectURL(new Blob([workerSrc])))`, then the worker calls
   `WebAssembly.instantiate(bytes)` (no MIME requirement). Lazy: created only when the page opens.

Target size: wasm < 1 MB after `-Oz` (xtce-rs + roxmltree + regex-lite).

---

## 3. Work items

### Phase 0 — xtce-rs prerequisites (in `~/git/xtce-rs`)

Gaps found while reading the code:

1. **wasm32 build.** Not checked yet (the `wasm32-unknown-unknown` target is not installed here).
   Likely issues: `lasso` `multi-threaded` feature, `env_logger` and `rand` as normal dependencies
   (move to dev-deps / optional feature `std-fs`), any `SystemTime::now()` (panics on wasm32).
   Add a CI check `cargo check --target wasm32-unknown-unknown --no-default-features`.
2. **Parse from strings, several documents.** `parse_files` reads paths; add
   `parse_strs(&[&str]) -> Result<MissionDatabase>` (and keep `parse_files` on top of it).
3. **Entry positions.** `ParameterValue` has no location. The viewer needs, for each extracted
   value: absolute bit offset, bit size, the sequence container of the entry and the container start
   offset (Java `ContainerParameterValue`). Add an opt-in `ExtractionOptions { positions: bool }` and
   a parallel `Vec<Option<EntryPosition>>` in the result (keeps the hot path unchanged when off).
4. **Matched containers.** Return the list of `(ContainerIdx, start_offset)` matched during
   extraction (Java `ContainerExtractionResult`) — the packet name is the last one at offset 0.
5. **Alarm ranges of a value.** The table shows the applicable warning (nominal) and critical
   (danger) ranges, which depend on the context alarms. Expose the range set selected while checking
   (`applied_ranges: Option<(Range, Range)>` or a function `applicable_alarm_ranges(mdb, &pv, ctx)`).
6. **Public accessors / formatting** for: calibrator description (Java `Calibrator.toString()`
   format), enumeration value list, OPS name (`MDB:OPS Name` alias), default calibrator of an encoding.
7. **Yamcs value formatting.** Eng/raw values are displayed and *compared in the filter* via Java
   `Value.toString()`: needs Java `Float.toString`/`Double.toString` formatting (`1.0E10`, `0.001`,
   `1.0`), timestamps as Yamcs ISO strings, binary as hex, enum labels, aggregates/arrays. Add
   `value::yamcs_string(&Value, ValueType)` + golden tests vs Java.
8. **Decode-only-what's-needed (perf, optional).** Java builds the list with an extractor that
   provides only the root's children + column/filter parameters. xtce-rs always extracts everything;
   measure first (target ≥ 200k packets/s for the list pass in wasm). Only if needed: a
   `wanted: Option<&BitSet<ParameterIdx>>` that skips value conversion of unwanted entries.
9. **Algorithms off.** The Java viewer's `XtceTmProcessor` has no algorithm manager; add a
   `TmProcessor` option to skip algorithms so outputs match.

Each item lands as its own commit in xtce-rs with tests.

**Status (2026-11-19): done** on xtce-rs branch `packet-viewer-support` (4 commits on top of
`phase0-hardening`): items 1, 2, 3, 4, 5, 6, 7, 9. Item 8 (decode-only-what's-needed) deferred until
Phase 1 measures the list pass. API: `parser::parse_strs`, `TmProcessor::process_with(…, &ProcessOptions)`
→ `TmResult { params, positions, containers, alarm_ranges }` + `packet_container()`,
`xtce_rs::format::{java_double, java_float, eng_value_to_string, raw_value_to_string,
calibrator_to_string}`, `NameDescription::ops_name()`.

Findings:
- The Java viewer never checks alarms (its `XtceTmProcessor` has no `ParameterProcessorManager`), so
  its Nominal/Danger columns are always empty. The web viewer can fill them from
  `TmResult::alarm_ranges` (warning → Nominal, critical → Danger) — a deliberate improvement.
- Yamcs has no text for `MathOperationCalibrator` (prints `Class@hash`); we print RPN.
- Java `Double.toString` reproduced exactly (0 differences on 400k random values vs JDK 25).

### Phase 1 — `pv-core` (pure Rust, native tests)

- `store`: append-only arena (`Vec<u8>` + `Vec<PacketMeta{offset,len,gentime,seq,name_idx}>`),
  ring behaviour for `maxLines` (drop oldest, keep continuous packet numbers like
  `continuousRowCount`), marks set, navigation history (10).
- `split`: `CcsdsSplitter`, `GenericSplitter` (exact `GenericPacketInputStream` semantics, errors on
  length > max), incremental (`push(chunk) -> packets`) so files are streamed with `File.stream()`.
- `prepro`: `Iss`, `Ccsds`, `Generic` preprocessors (time only; no CRC rejection unless configured).
- `decode`: list pass (name + column values + values needed by the current filter) and detail pass
  for the selected packet (full values + positions + matched containers + alarm ranges), the
  structure tree (same keying as Java `startOffset:opsName`), parameters table rows.
- `filter`: lexer/parser ported from `PacketFilter.jj`; `references()` for the parameters to
  extract; evaluator identical to `PacketFilter.matches`; `regex-lite` for MATCHES (Java regex
  differences documented).
- `hexdump`: text identical to `ListPacket.hexdump`, plus `highlight(bit_ranges) -> char spans`
  using the same nibble arithmetic as `highlightBitRanges`.
- **Golden tests vs Java**: a small Java harness (in `plugin/src/test` or `tools/`) runs Yamcs's
  `XtceTmProcessor`/`PacketFilter` on `packet-viewer/tm-data/testdata.ccsds` + the simulator MDB
  and dumps names, parameter tables, structure trees and filter results; Rust tests compare.

**Status (2026-11-19): done.** Modules `config`, `split`, `prepro`, `timefmt`, `filter`, `hexdump`,
`viewer` (the store is a `VecDeque` of boxed packets with interned names; rows, filter matches and
details are decoded on demand, statelessly). 25 tests; builds for wasm32.

Golden comparison: `tools/golden/run.sh` runs `tools/golden/Golden.java` (the Java viewer's list pass,
detail pass, tree building and `PacketFilter`) from the packet-viewer 5.14.1 distribution on its
quickstart MDB + `testdata.ccsds` (1800 packets) and 36 filters; `cargo test --test golden` compares:
151,273 lines identical (names, all parameter table rows, trees, filter validity and matches). The
packaged MDB has no calibrators, alarms or aliases, so those paths rely on the xtce-rs unit tests;
a richer data set belongs to Phase 5.

Findings:
- The packet-viewer test data goes with `packet-viewer/mdb-packaged/xtce.xml`, not the simulator MDB.
- In Java, a filter sees only the parameters subscribed when the packet was extracted (columns, or
  the filter set before loading); setting a filter on loaded packets misses other parameters. We
  decode on demand, so the filter always works — the golden harness emulates "filter set before
  loading".
- Java's grammar rejects unquoted decimals (`Height > 800.5`), negatives, `NOT x > 3` and
  `AND`/`OR` right after a bare reference inside parentheses; ours agrees on all 36 cases.

Performance (180k packets of 123 bytes / ~40 parameters, Node 24):

| | native | wasm (WASI in Node) |
|---|---|---|
| split | 0.13 µs/packet | 0.14 µs/packet |
| add (naming decode) | 4.2 µs/packet | 6.0 µs/packet (167k/s) |
| filter pass | 4.4 µs/packet | 6.3 µs/packet |
| 1000 rows, 2 columns | 6 ms | 12 ms |
| select (details + tree) | 43 µs | 57 µs |

The list pass is slightly under the 200k packets/s target and scales with the parameters per packet,
since every entry is decoded. Xtce-rs item 8 (decode only the parameters needed for container
selection, columns and filter) is the remedy; the cost is in xtce-rs's container extraction.

### Phase 2 — `pv-wasm` and the worker protocol

Message API (documented in `docs/protocol.md`), all async with request ids:

| request | reply |
|---|---|
| `loadMdb{xtce: string[]}` | `{containers, parameters, warnings[]}` |
| `configure{format, rootContainer, defaultNamespace, maxLines, columns[]}` | ok |
| `beginFile{size}` / `fileChunk{bytes}` (transferable) / `endFile` | progress events, `{count}` |
| `addPackets{[{bytes, gentime, seq}]}` (live/archive batches) | `{added, dropped, total}` |
| `rows{from, to}` (view indices, after filter) | `{rows:[{nr, gentime, name, length, cols[], marked}]}` |
| `setFilter{expr}` | `{ok, error?, matching}` with progress for large stores |
| `validateFilter{expr}` | `{ok, error?}` (for the red field) |
| `select{nr}` | `{params[], tree, hex, highlightsByParam}` |
| `highlight{ranges[]}` | `{spans}` |
| `addColumn/removeColumn{qualifiedName}`, `mark{nr}`, `clear`, `cancel` | … |
| `enumValues{param}` | LOV rows |

Filtering re-decodes only the referenced parameters; results kept as a bitset → view index map.
`cancel` is checked between chunks (the Java progress-dialog Cancel).

**Status (2026-11-19): done.** `wasm/` (crate `pv-wasm`, `js/worker.js`, `js/client.js` + `.d.ts`,
`build.mjs`), protocol in `docs/protocol.md`. Changes from the plan above:
- No wasm-bindgen/wasm-pack: the module exports a C ABI (`pv_alloc`, `pv_free`, `pv_call`: JSON request +
  binary payload → JSON reply) and has no imports. No tooling to install, nothing to keep in version lock.
- The worker reads the `File` itself (`openFile{file, format}`), instead of the UI sending chunks.
- Filtering runs in steps of 20000 packets (`Viewer::start_filter`/`filter_step`), so progress, cancel
  and other requests work during long scans; a new `openFile`/`setFilter` supersedes the running one.
- `configure`/`beginFile`/`fileChunk` from the table are `setSource`/`setMaxLines`/`addColumn`/`openFile`.

Bundle: wasm 983 KB (346 KB gzipped, opt-level 3 + LTO; no wasm-opt), client module 470 KB with the
gzipped wasm in base64. `wasm/test/e2e.mjs` runs the bundle in a Node worker thread: init, MDB, file,
rows, columns, filter (valid/invalid/cancel/supersede), details, highlight, LOV, copy hex, packets from
Yamcs; 180k packets load in 1.05 s and filter in 1.08 s.

### Phase 3 — Java plugin `web-packet-viewer`

Copy of the fops plugin skeleton (`FopsPlugin` extraction + `WebPlugin.addExtension`, plugin
metadata, `META-INF/services/org.yamcs.Plugin`), plus:

- Config in `yamcs.yaml`:
  ```yaml
  packetViewer:
    defaultNamespace: MDB:OPS Name   # optional
    liveMaxLines: 1000
    instances:
      simulator:
        stream: tm_realtime
        rootContainer: /YSS/ccsds-default     # optional
        fileFormats:                           # same keys as packet-viewer.yaml
          - name: CCSDS Packets
            packetInputStream: ccsds           # ccsds | generic
            packetInputStreamArgs: {...}
            preprocessor: iss                  # iss | ccsds | generic (+ args)
  ```
- `GET /api/packet-viewer/{instance}/config` — the block above, resolved with defaults.
- `GET /api/packet-viewer/{instance}/mdb` — XTCE of the whole instance MDB via `XtceAssembler`
  (same as `/api/mdb/{instance}/space-systems/:exportXTCE`), with `ETag` from an MDB hash and
  gzip; the UI caches it in IndexedDB keyed by `(instance, etag)`. If the MDB was loaded from XTCE
  files, optionally serve the original files instead (more faithful than the assembler).
- Privilege: `ReadPacket` (any) or superuser for the nav item and the endpoints; packets themselves
  use the standard APIs, so object privileges per packet still apply server-side.

**Risk:** `XtceAssembler` may not round-trip everything an MDB loaded from spreadsheets contains
(e.g. custom Java algorithms/calibrators, some encodings). Phase 3 includes an export→xtce-rs load
check on the simulator MDB and the examples, logging what is lost; the viewer log panel reports the
xtce-rs warnings at load ("N parameters unsupported").

**Status (2026-11-19): done.** `plugin/` (`PacketViewerPlugin`, `PacketViewerConfig`, `PacketViewerHandler`,
`MdbExports`), documented in `docs/plugin.md`; `dev/yamcs/` runs it with the PUS simulator on port 8091.
Changes from the plan above:
- Routes `/packet-viewer/api/{instance}/config|mdb` (a plugin route, like fops), both with GetMissionDatabase.
- The config keeps the keys of packet-viewer.yaml (`packetInputStreamClassName`, …), passed as is to the viewer;
  unsupported classes or unknown keys stop Yamcs at startup.
- `/mdb` answers JSON documents: **the original XTCE files** when the MDB is loaded only from XTCE files, else the
  `XtceAssembler` export. ETag + `If-None-Match` → 304; gzip comes from Yamcs (BodyHandler).

The export round trip (simulator = the Yamcs PUS example) found:
- Yamcs 5.14 `XtceAssembler` bugs: NPE on an `AbsoluteTimeArgumentType` without ReferenceTime (fails
  `:exportXTCE` of `/PUS` too) → we export a command-less copy of the MDB; the dynamic size of a
  `BinaryDataEncoding` is written as `FixedValue -1` → the original files are served whenever possible
  (`pus_export` golden test, ignored, documents it). Both worth reporting upstream.
- xtce-rs gaps, fixed on `packet-viewer-support`: `LinearAdjustment` without `slope`; odd-length hex
  (`<TerminationChar>0</TerminationChar>`); `ArgumentInstanceRef` in command types → new
  `parse_strs_with(…, ParseOptions { commands: false })`, used by the viewer; Yamcs `TimeBinaryDecoder` (CUC)
  implemented natively like `LeadingSizeBinaryDecoder` (as Yamcs, the `epoch` option is ignored: the decoded
  `pus-time` is 37 s before the packet time stamped by `PusPacketPreprocessor`).

Golden comparison extended: `tools/golden/pus/` (1090 packets recorded from the simulator, 9 packet types,
16 filters); `cargo test --test golden` → quickstart 151,273 and PUS 53,236 lines identical to Java. Two more Java
filter crashes found (NPE for a qualified name not in the packet, NumberFormatException for a numeric comparison
with a non-number): pv-core answers "no match". `wasm/test/live.mjs` runs plugin → archive API → worker: 200
archived packets, all named as Yamcs names them, no decoding error.

### Phase 4 — Angular extension (`web/`)

Copied setup from fops (`main.ts` with `createApplication` + `provideYamcsWebExtension`,
`postbuild.mjs`, single bundle). Elements:

- `<web-packet-viewer>` (startup): `addNavItem('telemetry', {path: 'ext/packet-viewer', label:
  'Packet Viewer', icon: 'view_list', condition: user => user.hasAnyObjectPrivilegeOfType('ReadPacket') || user.isSuperuser()})`,
  `disableReloadOnNavigation`.
- `<packet-viewer>` page (`ya-instance-page`, `ya-instance-toolbar` with File/Edit/Navigate/View
  `mat-menu`s mirroring the Java menu bar):
  - filter bar (input + history dropdown + Clear, red when invalid)
  - split panes: packets table | (tabs Parameters/Structure + find bar) / hex dump; log at bottom
  - dialogs: Open source (Live / Archive / Local file + format + MDB choice), Go to Packet,
    List of Values
  - keyboard map scoped to the page; prefs (`columns`, `filterHistory`, `recent`, last source) in
    `localStorage` per instance
- `worker-client.ts`: typed request/response wrapper over the blob worker.
- Sources:
  - **live**: the SDK has no `createPacketSubscription`; use the WebSocket client's generic
    `createSubscription('packets', {instance, stream, processor}, cb)` (reachable via the SDK's
    `YamcsClient`; if it's not public, add a small public method in webapp-sdk upstream or open a
    second WebSocket with the same session cookie). Batch messages every 100 ms into `addPackets`.
  - **archive**: `GET /api/archive/{instance}/packets` paged with `next` (has gentime, name, seq),
    names from `/packet-names`; large ranges stream with continuation and progress.
  - **local file**: `File.stream()` → chunks transferred to the worker.

### Phase 5 — Parity & performance pass

- Side-by-side checklist against the Java viewer on the simulator (live + `testdata.ccsds`).
- Perf targets: 1M-packet file loads without the tab freezing; filter over 100k packets < 1 s;
  selection decode < 10 ms; memory ≈ file size + small per-packet overhead.
- Playwright smoke test against a local Yamcs simulator (`run-example.sh`).

**Status (2026-11-19): done.** Checklist and measurements in `docs/parity.md`: all four targets met in wasm
(1M packets in 6.4 s with the main thread free, filter over 100k in 0.63 s, selection 0.38 ms, 35 bytes per
packet beyond the data); xtce-rs item 8 not needed. Fixed: auto-scroll/select while a file loads, Java log
messages, Go to Packet messages, Hide Column disabled on fixed columns, no second filter pass after a load,
scaled scrolling beyond 8M px. `web/e2e/smoke.spec.ts` (Playwright, installed Chrome) against `dev/yamcs`.
Found in Yamcs 5.14, to report: a change in an extension's directory crashes the Yamcs-web redeployer
(`WebFileDeployer$Redeployer`, NullPointerException: no source directory when the webapp comes from the jar)
after deleting the deployed webapp, so Yamcs-web answers 404 until restarted.

---

## 4. Decisions taken by default (change if you disagree)

1. **MDB from the server via XTCE export**, cached by ETag; a local XTCE file can be chosen instead.
   (No serialized Java MDB like the Swing client.)
2. **Viewer-specific config lives in the plugin's `yamcs.yaml` block**, not in a separate
   `packet-viewer.yaml`.
3. Only Yamcs-web's session is used — no separate server connection dialog.
4. Selected-packet decoding is **stateless per packet** (like the Java viewer, no algorithms);
   references to previous instances resolve against the previously *listed* packets only where Java
   does the same.
5. New repos/dirs as in §2; xtce-rs changes go to the xtce-rs repo as separate commits.

## 5. Order of work and rough size

| Phase | Content | Size |
|---|---|---|
| 0 | xtce-rs: wasm build, `parse_strs`, positions, matched containers, alarm ranges, Yamcs value formatting | M |
| 1 | pv-core + Java golden harness | L |
| 2 | pv-wasm, worker protocol, single-bundle build | M |
| 3 | Java plugin (extension, config, MDB endpoint, XTCE round-trip check) | S–M |
| 4 | Angular UI, 3 packet sources | L |
| 5 | parity checklist, perf, e2e | M |

Phases 0 and 3 are independent and can run in parallel; 1 needs 0; 2 needs 1; 4 can start on
mocked worker replies once the protocol (Phase 2 doc) is written.
