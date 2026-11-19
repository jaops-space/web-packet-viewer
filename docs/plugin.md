# The Yamcs plugin

`plugin/` builds `com.jaops.yamcs:web-packet-viewer`, a Yamcs 5.14 plugin. Put the jar in Yamcs's `lib/`
(or add the dependency to a `yamcs:run` project). It:

- adds the Packet Viewer to Yamcs-web: the `packet-viewer-web/` directory of the jar (built from `web/dist`) is
  extracted to `<dataDir>/packet-viewer/web` and registered with `WebPlugin.addExtension("web-packet-viewer")`;
- serves what the browser needs besides the standard Yamcs APIs, under `/packet-viewer/api/{instance}/`.

The packets themselves come from the standard Yamcs APIs (WebSocket topic `packets`,
`/api/archive/{instance}/packets`), with their usual privileges.

## Configuration

The `packetViewer:` section of `yamcs.yaml`, optional. The viewer keys are those of the Java packet viewer's
`packet-viewer.yaml`; an instance may override each of them.

```yaml
packetViewer:
  defaultNamespace: MDB:OPS Name     # packet names: alias in this namespace, else qualified name
  liveMaxLines: 1000                 # packets kept in live mode (0: no limit); default 1000
  stream: tm_realtime                # the stream of the live packets; default tm_realtime
  # the preprocessor of the file formats that have none (default: IssPacketPreprocessor)
  packetPreprocessorClassName: org.yamcs.tctm.GenericPacketPreprocessor
  packetPreprocessorArgs: { timestampOffset: 13, seqCountOffset: 2, timeEncoding: { type: CUC, epoch: UNIX } }
  fileFormats:                       # the formats offered when opening a file; default "CCSDS Packets"
    - name: CCSDS Packets
      packetInputStreamClassName: org.yamcs.tctm.CcsdsPacketInputStream
      packetInputStreamArgs: {}
      packetPreprocessorClassName: …   # optional
      packetPreprocessorArgs: …        # optional
      rootContainer: /a/b              # optional
  instances:
    simulator:
      stream: tm_realtime
      rootContainer: /YSS/ccsds-default   # default: the MDB's root container
      fileFormats: […]                    # any key above
```

The browser implements `org.yamcs.tctm.CcsdsPacketInputStream`, `org.yamcs.tctm.GenericPacketInputStream`,
`org.yamcs.tctm.IssPacketPreprocessor` and `org.yamcs.tctm.GenericPacketPreprocessor`; Yamcs does not start
with another class or an unknown key in this section.

## HTTP API

Both resources need the `GetMissionDatabase` privilege (like the XTCE export of Yamcs). Errors have the Yamcs
format `{code, type, msg}`; responses are gzipped when the client accepts it.

### `GET /packet-viewer/api/{instance}/config`

```json
{
  "instance": "simulator",
  "stream": "tm_realtime",
  "tmStreams": ["tm_realtime", "tm_dump"],
  "rootContainer": "/PUS/ccsds",
  "liveMaxLines": 1000,
  "mdbEtag": "\"9d322ba374072e572432e9da74042b8f\"",
  "viewer": { "fileFormats": [ … ], "defaultNamespace": "…", … }
}
```

`tmStreams` are the `tm` streams of the instance's `streamConfig`, offered for the live packets. `viewer` is passed as is to the worker (`init`), `rootContainer` to `loadMdb`. `rootContainer` is the configured
one, else `Mdb.getRootSequenceContainer()` (which the browser cannot work out: XTCE has no declaration order
in xtce-rs).

### `GET /packet-viewer/api/{instance}/mdb`

```json
{ "source": "files", "documents": [ { "name": "pus.xml", "xtce": "<?xml …" }, … ] }
```

The documents for `loadMdb`, with an `ETag` (also in the config as `mdbEtag`) and `Cache-Control: no-cache`:
with `If-None-Match` the answer is `304 Not Modified` while the MDB is unchanged, so the browser can keep it
(e.g. in IndexedDB) and download it again only after a change. It is recomputed when the instance restarts.

- `source: files`: the MDB of the instance is loaded only by `xtce` loaders without `subLoaders` (in the instance
  configuration, `mdb:` or `mdbSpec:`); the documents are these files, in order. This is exact.
- `source: export`: otherwise, a single document produced by the XTCE assembler of Yamcs from the loaded MDB,
  without the commands (the viewer does not need them, and the assembler fails on some command definitions). The
  Yamcs 5.14 assembler loses some definitions: the dynamic size of a binary encoding is written as a fixed `-1`.

## Development

`dev/yamcs/` is a `yamcs:run` project with the plugin and the Yamcs PUS simulator (see `dev/README.md`).
