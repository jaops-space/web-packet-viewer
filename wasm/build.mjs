// Builds dist/packet-viewer-client.js: the client with the worker and the gzipped wasm embedded.
// node build.mjs [--debug]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const release = !process.argv.includes('--debug');
execFileSync(
  'cargo',
  ['build', '-p', 'pv-wasm', '--target', 'wasm32-unknown-unknown', ...(release ? ['--release'] : [])],
  { cwd: here, stdio: 'inherit' },
);
const wasm = readFileSync(
  join(here, '../target/wasm32-unknown-unknown', release ? 'release' : 'debug', 'pv_wasm.wasm'),
);
const gz = gzipSync(wasm, { level: 9 });
const worker =
  `const WASM_GZ_BASE64 = ${JSON.stringify(gz.toString('base64'))};\n` +
  readFileSync(join(here, 'js/worker.js'), 'utf8');
const client = readFileSync(join(here, 'js/client.js'), 'utf8').replace(
  '__WORKER_SOURCE__',
  () => JSON.stringify(worker),
);
mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist/packet-viewer-client.js'), client);
copyFileSync(join(here, 'js/client.d.ts'), join(here, 'dist/packet-viewer-client.d.ts'));
console.log(`wasm ${wasm.length} bytes, gzipped ${gz.length}; client ${client.length} bytes`);
