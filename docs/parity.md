# Parity with the Java packet viewer

The reference is `packet-viewer` of the Yamcs repository (Yamcs 5.14). Decoding and filtering are checked
automatically against Java (`core/tests/golden.rs`, from `tools/golden/run.sh`: packet names, parameter
tables, structure trees and filter matches, identical on the quickstart and PUS data). The UI was compared by
reading the Java code side by side; `web/e2e/smoke.spec.ts` covers the main paths in a running Yamcs.

## Same as Java

| Area | Behaviour |
|---|---|
| Packets table | `#`, Generation Time (`yyyy-MM-dd/DDDTHH:mm:ss.SSS`), Packet Name (deepest container at offset 0, alias in `defaultNamespace`), Length, parameter columns; no sorting; numbering restarts at 1 on Clear and on a new source |
| Max lines | unlimited for files, `liveMaxLines` (default 1000, Java `-l` default for realtime) for live; the oldest rows are dropped with their marks and history entries |
| Parameter columns | Apply as Left Column; header right-click → Hide Column (disabled on the fixed columns); header = parameter name; persisted (per instance) |
| Mark | Ctrl+M, Mark/Unmark Packet in the Edit menu and the row menu, yellow rows |
| Navigation | Go to Packet (Ctrl+G; `Cannot parse packet number`, `There is no packet number N`; range = first number + visible rows − 1 as in Java), Back/Forward (Alt+←/→, history of 10), Previous/Next (Alt+↑/↓; with no selection: the first row) |
| View | Auto-Scroll To Last Packet (on), Auto-Select Last Packet (off), for live and while a file loads; Clear |
| Display filter | grammar and semantics (golden tests), red while invalid, history of 10 (most recent first, moved to the front when reused), Clear button enabled with text, an empty filter shows everything |
| Parameters tab | Name, Eng Value, Raw Value, Nominal Low/High, Danger Low/High, Bit Offset, Bit Size, Calibration; zebra rows; multi-selection highlights the bits; enumeration → List of Values with the raw value selected |
| Apply as Filter | `name == value` / `!(name == value)` |
| Find bar | Ctrl+F, substring of the name ignoring case, next/previous with wrap, `n of m`, `Parameter not found`, bold matches, Esc |
| Structure tab | containers by inheritance and start offset, leaves `bitOffset/bitSize name`, multi-selection highlights |
| Hex dump | 16 bytes a line, offsets in grey, highlights at nibble precision in hex and ASCII, scrolled to the first; Copy hex (upper case) |
| Log | `Loaded definition of …`, `Loaded N packets from "file"`, `Encountered end of file while loading …`, `Cancelled loading …`, `Error while loading …`, `preprocessor returned null packet`, `disconnected` |
| Loading a file | progress with Cancel; Cancel clears the window as in Java |

## Deliberately different

| Java | Web | Why |
|---|---|---|
| Connect to Yamcs: URL, credentials, instance, stream, server or local MDB | the Yamcs-web session and instance; Connect asks only for the stream | no separate connection in the browser |
| MDB loaded on connect / file open (`mdb.yaml` name) | the instance MDB, loaded when the page opens; File → Mission Database… for local XTCE files | the browser has no `etc/` |
| Recent files reopen by path | the name and format are remembered; choosing the item asks for the file again | browsers cannot reopen a file by path |
| Log path of the file | its name | the browser does not know the path |
| Nominal/Danger columns always empty (no alarm checking in its processor) | filled from the alarm ranges of the MDB | improvement |
| Go to a packet hidden by the filter: exception | a message, the packet's details are shown | Java bug |
| Filter on a qualified name not in the packet: NullPointerException; numeric compare with a non-number: NumberFormatException | no match | Java bugs |
| — | Archive source (time range, packet names) | addition |
| — | Disconnect button, packet counts next to the filter, progress of the filter | additions |
| Window title `Yamcs Packet Viewer - file` | the source in the page toolbar | Yamcs-web page |

## Not ported

Quit, `--etc-dir`, authentication options, Kerberos: no meaning in Yamcs-web.

## Performance (Phase 5 targets)

`node wasm/test/perf.mjs`, the worker bundle in Node; the browser figures are from Chrome on the dev Yamcs.

| Target | Measured |
|---|---|
| a 1M-packet file loads without freezing the tab | 1,000,800 packets (117 MB) in 6.4 s (157k packets/s), main thread lag ≤ 1 ms; in Chrome, 4,113,615 PUS packets (254 MB) in 9.2 s, End and Go to Packet instant |
| filter over 100k packets < 1 s | 631 ms (quickstart MDB); 4.1M PUS packets in 9.0 s |
| selection decode < 10 ms | 0.38 ms |
| memory ≈ file size + small overhead | 35 bytes per packet beyond the data |

The table scales its scrolling above 8M px (browsers cap the height of an element), so millions of rows scroll.

xtce-rs item 8 (decode only what the list needs) was not done: the targets are met without it, and it needs
xtce-rs to know every parameter that criteria, sizes, locations and repeat counts refer to. Measured, the list
pass costs ~40 ns of raw extraction and ~25 ns of calibration per value (about 40 values per quickstart
packet), with no single hotspot.
