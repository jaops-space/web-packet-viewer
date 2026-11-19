# Packet Viewer web UI (Yamcs-web extension)

Angular 22 custom elements on `@yamcs/webapp-sdk` 1.6.7 (the versions of Yamcs 5.14), set up like fops.

```bash
npm install
npm run wasm         # ../wasm/dist/packet-viewer-client.js (cargo, wasm32-unknown-unknown)
npm run build        # dist/web-packet-viewer.js, dist/web-packet-viewer.css
```

The plugin build (`../plugin`) puts `dist/` in the jar. Keep it one bundle (`scripts/postbuild.mjs` fails on lazy
chunks); the worker and the wasm are embedded in the client module.

```bash
npm run e2e          # Playwright smoke tests against a running Yamcs (dev/yamcs; PV_URL, PV_INSTANCE)
```

## Elements

- `<web-packet-viewer>`, created by Yamcs-web at startup: adds **Packet Viewer** to the Telemetry group
  (users with a `ReadPacket` object privilege, or superusers).
- `<packet-viewer>`, routed at `/ext/packet-viewer?c=<instance>`: the Java viewer's window.

## Where things are

| file | what |
|---|---|
| `viewer.ts` | the state of the viewer (a root service: it survives navigation to other pages, live included); the worker client; the sources: live (WebSocket topic `packets`, batched every 100 ms), archive (`/api/archive/{instance}/packets`, paged), local file |
| `api.ts` | the plugin API (`docs/plugin.md`); the MDB is kept in the Cache Storage with its ETag |
| `viewer.element.ts` | toolbar (Pause/Resume, Clear, more menu), filter bar, navigation bar, split panes, status line, file drop, keyboard |
| `source-bar.ts` | the source: live stream, archive range + packet names, local file + format |
| `packets-table.ts` | the packets table, virtual: the rows in view are fetched from the worker |
| `details.ts` | Parameters and Structure tabs, find bar |
| `hexdump.ts` | hex dump with highlighted bit ranges |
| `dialogs.ts` | Mission database (local XTCE files), Go to Packet, List of Values |
| `prefs.ts` | per instance in browser storage: parameter columns and widths, filter history, last source (stream, archive range, file format), View options, pane sizes |

## Keyboard

Ctrl+O open a file, Ctrl+F find parameter, Ctrl+M mark, Ctrl+G go to packet, Alt+←/→ back/forward,
Alt+↑/↓ previous/next packet; ↑/↓, PgUp/PgDn, Home/End in the packets table.

A recent file cannot be reopened by the browser itself: choosing it from the File menu asks for the file again,
with its format.
