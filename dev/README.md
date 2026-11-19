# Development environment: Yamcs with the packet viewer plugin and the PUS simulator

`dev/yamcs/` is a `yamcs:run` project: Yamcs 5.14.1 on port **8091**, instance `simulator` running the PUS
simulator of the Yamcs repository inside Yamcs (the `SimulatorCommander` service; TM on TCP 10215, TC on 10225,
so that it can run next to the fops development Yamcs). Its configuration and MDB come from `examples/pus` of the
Yamcs repository, as in fops. Security is off.

```bash
(cd web && npm install && npm run wasm && npm run build)
(cd plugin && mvn install)
```

```bash
cd dev/yamcs && mvn yamcs:run
```

The viewer is at http://localhost:8091/ext/packet-viewer?c=simulator (Telemetry → Packet Viewer).

The API of the plugin:

```bash
curl -s localhost:8091/packet-viewer/api/simulator/config
```

The whole chain (plugin, Yamcs archive API, wasm worker), once some packets are archived:

```bash
(cd wasm && node build.mjs && node test/live.mjs)
```

The smoke tests of the web UI (Playwright, with the installed Google Chrome), once some packets are archived:

```bash
(cd web && npm run e2e)
```

After rebuilding the web UI, rebuild the plugin and restart Yamcs. Do not copy files into
`target/yamcs/yamcs-data/packet-viewer/web`: Yamcs-web watches that directory, and in Yamcs 5.14 its redeploy
fails (NullPointerException) after deleting the webapp, which then answers 404 until Yamcs restarts.
