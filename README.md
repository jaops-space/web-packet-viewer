# web-packet-viewer

The Yamcs packet viewer in Yamcs-web: **Telemetry → Packet Viewer**. The packets of a Yamcs stream (live), of the
Yamcs archive or of a local file are decoded in the browser, in a Web Worker running WebAssembly built on
[xtce-rs](https://crates.io/crates/xtce-rs). It works like the Java packet viewer of Yamcs (`packet-viewer`): same packets table,
display filter, parameters, structure and hex dump (see [docs/parity.md](docs/parity.md)).

| directory | what |
|---|---|
| `core/` | `pv-core`: the viewer in Rust (file formats, preprocessors, naming, filter, details), tested against the Java viewer |
| `wasm/` | `pv-wasm`: the WebAssembly module, its worker and the JavaScript client ([docs/protocol.md](docs/protocol.md)) |
| `web/` | the Yamcs-web extension (Angular) |
| `plugin/` | the Yamcs plugin `com.jaops.yamcs:web-packet-viewer`: serves the UI, the configuration and the MDB ([docs/plugin.md](docs/plugin.md)) |
| `dev/` | a Yamcs with the plugin and the PUS simulator, for development ([dev/README.md](dev/README.md)) |
| `tools/golden/` | the Java side of the golden tests |

## Build

Needs Rust with the `wasm32-unknown-unknown` target, Node 24, Java 17 and Maven.

```bash
(cd web && npm install && npm run wasm && npm run build)
(cd plugin && mvn install)
```

Put `plugin/target/web-packet-viewer-*.jar` in Yamcs's `lib/` (Yamcs 5.14); the `packetViewer:` section of
`yamcs.yaml` is optional.

## Tests

```bash
cargo test                                # pv-core, golden tests (tools/golden/run.sh first)
(cd wasm && node test/e2e.mjs && node test/perf.mjs)
(cd web && npm run e2e)                   # against dev/yamcs
```
